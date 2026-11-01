import type { Day, PlanEntry, PlanHistoryEntry, State } from '../engine';
import { weekOfIsoKey } from '../engine';
import type { StoreWarning } from './ports';
import { parseDay } from './project';

export const STATE_PATH = '_taskmaster/state.json';

/** The part of State that lives in state.json. Dates are ISO strings on disk. */
export type StateFile = Pick<State, 'tiers' | 'plan' | 'planHistory'> & {
  weekly: number;
  weekCap: Record<number, number>;
  holidays: Day[];
};

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
export function parseStateFile(raw: string): { file: StateFile; warnings: StoreWarning[] } {
  const file = defaultStateFile();
  const warnings: StoreWarning[] = [];
  const warn = (msg: string, field?: string) => warnings.push({ path: STATE_PATH, field, msg });

  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    warn('Not valid JSON. Using defaults');
    return { file, warnings };
  }
  if (!isObject(root)) {
    warn('Not a JSON object. Using defaults');
    return { file, warnings };
  }

  const { tiers, plan, planHistory, capacity, weekCapacity, holidays } = root;

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

  return { file, warnings };
}
