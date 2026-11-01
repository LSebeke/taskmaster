import type { DataAdapter } from 'obsidian';
import type { Day, PlanEntry, PlanHistoryEntry, State } from '../engine';
import { iso, isoWeekKey, weekOfIsoKey } from '../engine';
import type { StoreWarning } from './ports';
import { parseDay } from './project';

export const STATE_PATH = '_taskmaster/state.json';
export const STATE_TMP = `${STATE_PATH}.tmp`;
/** A state.json that would not parse, kept before the first write replaces it. */
export const STATE_BAD = `${STATE_PATH}.bad`;

/** The part of State that lives in state.json. Dates are ISO strings on disk. */
export type StateFile = Pick<State, 'tiers' | 'plan' | 'planHistory' | 'order'> & {
  weekly: number;
  weekCap: Record<number, number>;
  holidays: Day[];
};

const planEntry = (e: PlanEntry) => ({ start: iso(e.start), end: iso(e.end), hours: e.hours });
const planEntries = (o: Partial<Record<string, PlanEntry>>) => Object.fromEntries(Object.entries(o).flatMap(([k, e]) => (e ? [[k, planEntry(e)]] : [])));

/** The inverse of parseStateFile. */
export function serializeState(st: State): string {
  const { weekly, weekCap, holidays } = st.settings;
  return `${JSON.stringify(
    {
      tiers: st.tiers,
      plan: planEntries(st.plan),
      planHistory: (st.planHistory ?? []).map(h => ({ day: iso(h.day), ids: h.ids, before: planEntries(h.before) })),
      capacity: weekly,
      weekCapacity: Object.fromEntries(Object.entries(weekCap ?? {}).map(([w, h]) => [isoWeekKey(Number(w)), h])),
      holidays: holidays.map(iso),
      ...(st.order?.length ? { order: st.order } : {}),
    },
    null,
    2,
  )}\n`;
}

type StateAdapter = Pick<DataAdapter, 'exists' | 'write' | 'rename' | 'remove' | 'mkdir'>;

/**
 * Write beside it, then swap. Some adapters refuse to rename over a file, so the swap can need two
 * steps. A crash between them leaves the whole new file at STATE_TMP, which load picks up.
 */
export async function writeStateAtomically(adapter: StateAdapter, json: string): Promise<void> {
  const dir = STATE_PATH.split('/')[0];
  if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
  await adapter.write(STATE_TMP, json);
  try {
    await adapter.rename(STATE_TMP, STATE_PATH);
  } catch {
    await adapter.remove(STATE_PATH);
    await adapter.rename(STATE_TMP, STATE_PATH);
  }
}

export const defaultStateFile = (): StateFile => ({ tiers: [], plan: {}, planHistory: [], weekly: 30, weekCap: {}, holidays: [] });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parsePlanEntry(v: unknown): PlanEntry | undefined {
  if (!isObject(v) || typeof v.hours !== 'number') return undefined;
  const start = parseDay(v.start);
  const end = parseDay(v.end);
  return start === undefined || end === undefined ? undefined : { start, end, hours: v.hours };
}

function parseHistoryEntry(v: unknown): PlanHistoryEntry | undefined {
  if (!isObject(v) || !isObject(v.before) || !Array.isArray(v.ids)) return undefined;
  const day = parseDay(v.day);
  if (day === undefined || !v.ids.every(i => typeof i === 'string')) return undefined;
  const before = Object.fromEntries(Object.entries(v.before).map(([k, e]) => [k, parsePlanEntry(e)]));
  return { day, ids: v.ids as string[], before };
}

/** Every field is optional. A bad field or entry is skipped and reported, the rest still load. */
export function parseStateFile(raw: string): { file: StateFile; warnings: StoreWarning[]; broken?: boolean } {
  const file = defaultStateFile();
  const warnings: StoreWarning[] = [];
  const warn = (msg: string, field?: string) => warnings.push({ path: STATE_PATH, field, msg });

  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    warn(`Not valid JSON. Using defaults, a copy stays at ${STATE_BAD}`);
    return { file, warnings, broken: true };
  }
  if (!isObject(root)) {
    warn(`Not a JSON object. Using defaults, a copy stays at ${STATE_BAD}`);
    return { file, warnings, broken: true };
  }

  const { tiers, plan, planHistory, capacity, weekCapacity, holidays, order } = root;

  if (Array.isArray(tiers)) {
    const seen = new Set<string>();
    for (const level of tiers) {
      if (!Array.isArray(level)) {
        warn('Skipped a level that is not a list', 'tiers');
        continue;
      }
      file.tiers.push(
        level.filter(id => {
          if (typeof id !== 'string') warn(`Skipped ${JSON.stringify(id)}`, 'tiers');
          else if (seen.has(id)) return false;
          else seen.add(id);
          return typeof id === 'string';
        }),
      );
    }
  } else if (tiers !== undefined) warn('Expected a list of levels', 'tiers');

  if (isObject(plan)) {
    for (const [id, e] of Object.entries(plan)) {
      const entry = parsePlanEntry(e);
      if (entry) file.plan[id] = entry;
      else warn(`Skipped the entry for ${id}`, 'plan');
    }
  } else if (plan !== undefined) warn('Expected an object', 'plan');

  if (Array.isArray(planHistory)) {
    for (const e of planHistory) {
      const entry = parseHistoryEntry(e);
      if (entry) file.planHistory!.push(entry);
      else warn('Skipped an entry', 'planHistory');
    }
  } else if (planHistory !== undefined) warn('Expected a list', 'planHistory');

  if (typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0) file.weekly = capacity;
  else if (capacity !== undefined) warn(`Expected weekly hours, got ${JSON.stringify(capacity)}`, 'capacity');

  if (isObject(weekCapacity)) {
    for (const [key, hours] of Object.entries(weekCapacity)) {
      const week = weekOfIsoKey(key);
      if (week !== undefined && typeof hours === 'number' && Number.isFinite(hours) && hours >= 0) file.weekCap[week] = hours;
      else warn(`Skipped ${key}`, 'weekCapacity');
    }
  } else if (weekCapacity !== undefined) warn('Expected an object', 'weekCapacity');

  if (Array.isArray(holidays)) {
    for (const h of holidays) {
      const d = parseDay(h);
      if (d === undefined) warn(`Skipped ${JSON.stringify(h)}`, 'holidays');
      else file.holidays.push(d);
    }
  } else if (holidays !== undefined) warn('Expected a list of dates', 'holidays');

  if (Array.isArray(order)) file.order = order.filter(id => typeof id === 'string');
  else if (order !== undefined) warn('Expected a list', 'order');

  return { file, warnings };
}
