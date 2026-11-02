import type { DataAdapter } from 'obsidian';
import type { Day, PlanEntry, PlanHistoryEntry, State } from '../engine';
import { iso, isoWeekKey, weekOfIsoKey } from '../engine';
import { mover, type StoreWarning } from './ports';
import { parseDay } from './project';

export const STATE_PATH = '_taskmaster/state.json';
export const STATE_TMP = `${STATE_PATH}.tmp`;
/** A state.json that would not parse, kept before the first write replaces it. */
export const STATE_BAD = `${STATE_PATH}.bad`;

/** What state.json holds, as engine values: the one list of them. Top-level fields of State, then settings. */
const FIELDS = ['tiers', 'plan', 'planHistory', 'order', 'timer', 'folder'] as const;
const SETTINGS = ['weekly', 'weekCap', 'holidays', 'staleDays'] as const;
/** Those holding note paths. */
const PATH_FIELDS = ['tiers', 'plan', 'planHistory', 'order', 'timer'] as const;

export type StateParts = Pick<State, (typeof FIELDS)[number]> & Pick<State['settings'], (typeof SETTINGS)[number]>;

/** The parts as they stand, not a copy. */
export function liveParts(st: State): StateParts {
  const out: Partial<Record<keyof StateParts, unknown>> = {};
  for (const k of FIELDS) out[k] = st[k];
  for (const k of SETTINGS) out[k] = st.settings[k];
  return out as StateParts;
}

export const partsOf = (st: State): StateParts => structuredClone(liveParts(st));

export function assignParts(st: State, p: Partial<StateParts>) {
  const into = st as unknown as Record<string, unknown>;
  const settings = st.settings as unknown as Record<string, unknown>;
  for (const k of FIELDS) if (k in p) into[k] = p[k];
  for (const k of SETTINGS) if (k in p) settings[k] = p[k];
}

/** Parts of `before` that differ from `after`. */
export function changedParts(before: StateParts, after: StateParts): Partial<StateParts> {
  const keys = Object.keys(before) as (keyof StateParts)[];
  const changed = keys.filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  return Object.fromEntries(changed.map(k => [k, before[k]]));
}

/** Compares before and after a rename. */
export const pathsKey = (st: State) => JSON.stringify(PATH_FIELDS.map(k => st[k]));

/** Plan entries, history and levels are keyed by note path. A folder rename moves everything under it. */
export function rewritePaths(p: Partial<Pick<StateParts, (typeof PATH_FIELDS)[number]>>, from: string, to: string) {
  const move = mover(from, to);
  const moveKeys = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [move(k), v]));
  if (p.tiers) p.tiers = p.tiers.map(level => level.map(move));
  if (p.plan) p.plan = moveKeys(p.plan);
  if (p.order) p.order = p.order.map(move);
  if (p.timer) p.timer = { ...p.timer, id: move(p.timer.id) };
  for (const h of p.planHistory ?? []) {
    h.ids = h.ids.map(move);
    h.before = moveKeys(h.before);
  }
}

/** What parsing state.json gives: the parts, and what it could not use. */
export type StateFile = Omit<StateParts, 'staleDays' | 'weekCap'> & { weekCap: Record<number, number>; staleDays?: number; kept?: Kept };

/** What a load could not use. A save writes it back as it came: hand edits and newer versions lose nothing. */
export interface Kept {
  /** Bad values and entries, by field. */
  skipped: Record<string, unknown[]>;
  /** Keys this version does not know. */
  unknown: Record<string, unknown>;
}

const planEntry = (e: PlanEntry) => ({ start: iso(e.start), end: iso(e.end), hours: e.hours });
const planEntries = (o: Partial<Record<string, PlanEntry>>) => Object.fromEntries(Object.entries(o).flatMap(([k, e]) => (e ? [[k, planEntry(e)]] : [])));

/** The inverse of parseStateFile. */
export function serializeState(st: State, kept?: Kept): string {
  const { weekly, weekCap, holidays, staleDays } = st.settings;
  return `${JSON.stringify(
    {
      ...kept?.unknown,
      tiers: st.tiers,
      plan: planEntries(st.plan),
      planHistory: (st.planHistory ?? []).map(h => ({ day: iso(h.day), ids: h.ids, before: planEntries(h.before) })),
      capacity: weekly,
      weekCapacity: Object.fromEntries(Object.entries(weekCap ?? {}).map(([w, h]) => [isoWeekKey(Number(w)), h])),
      holidays: holidays.map(iso),
      staleDays,
      projectsFolder: st.folder,
      ...(st.timer ? { timer: { id: st.timer.id, since: new Date(st.timer.since).toISOString() } } : {}),
      ...(st.order?.length ? { order: st.order } : {}),
      ...(kept && Object.keys(kept.skipped).length ? { skipped: kept.skipped } : {}),
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

const KNOWN = new Set(['tiers', 'plan', 'planHistory', 'capacity', 'weekCapacity', 'holidays', 'staleDays', 'projectsFolder', 'timer', 'order', 'skipped']);

/** Every field is optional. A bad field or entry is skipped, reported and kept for the next save; the rest still load. */
export function parseStateFile(raw: string): { file: StateFile; warnings: StoreWarning[]; broken?: boolean } {
  const file = defaultStateFile();
  const warnings: StoreWarning[] = [];
  const warn = (msg: string, field?: string) => warnings.push({ path: STATE_PATH, field, msg });
  const skipped: Record<string, unknown[]> = {};
  const skip = (msg: string, field: string, value: unknown) => {
    warn(msg, field);
    (skipped[field] ||= []).push(value);
  };

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

  const { tiers, plan, planHistory, capacity, weekCapacity, holidays, order, staleDays, projectsFolder, timer } = root;
  file.kept = { skipped, unknown: Object.fromEntries(Object.entries(root).filter(([k]) => !KNOWN.has(k))) };
  if (isObject(root.skipped)) {
    for (const [field, values] of Object.entries(root.skipped)) if (Array.isArray(values)) skipped[field] = [...values];
  }

  if (Array.isArray(tiers)) {
    const seen = new Set<string>();
    for (const level of tiers) {
      if (!Array.isArray(level)) {
        skip('Skipped a level that is not a list', 'tiers', level);
        continue;
      }
      file.tiers.push(
        level.filter(id => {
          if (typeof id !== 'string') skip(`Skipped ${JSON.stringify(id)}`, 'tiers', id);
          else if (seen.has(id)) return false;
          else seen.add(id);
          return typeof id === 'string';
        }),
      );
    }
  } else if (tiers !== undefined) skip('Expected a list of levels', 'tiers', tiers);

  if (isObject(plan)) {
    for (const [id, e] of Object.entries(plan)) {
      const entry = parsePlanEntry(e);
      if (entry) file.plan[id] = entry;
      else skip(`Skipped the entry for ${id}`, 'plan', { [id]: e });
    }
  } else if (plan !== undefined) skip('Expected an object', 'plan', plan);

  if (Array.isArray(planHistory)) {
    for (const e of planHistory) {
      const entry = parseHistoryEntry(e);
      if (entry) file.planHistory!.push(entry);
      else skip('Skipped an entry', 'planHistory', e);
    }
  } else if (planHistory !== undefined) skip('Expected a list', 'planHistory', planHistory);

  if (typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0) file.weekly = capacity;
  else if (capacity !== undefined) skip(`Expected weekly hours, got ${JSON.stringify(capacity)}`, 'capacity', capacity);

  if (isObject(weekCapacity)) {
    for (const [key, hours] of Object.entries(weekCapacity)) {
      const week = weekOfIsoKey(key);
      if (week !== undefined && typeof hours === 'number' && Number.isFinite(hours) && hours >= 0) file.weekCap[week] = hours;
      else skip(`Skipped ${key}`, 'weekCapacity', { [key]: hours });
    }
  } else if (weekCapacity !== undefined) skip('Expected an object', 'weekCapacity', weekCapacity);

  if (Array.isArray(holidays)) {
    for (const h of holidays) {
      const d = parseDay(h);
      if (d === undefined) skip(`Skipped ${JSON.stringify(h)}`, 'holidays', h);
      else file.holidays.push(d);
    }
  } else if (holidays !== undefined) skip('Expected a list of dates', 'holidays', holidays);

  if (typeof staleDays === 'number' && Number.isInteger(staleDays) && staleDays >= 1) file.staleDays = staleDays;
  else if (staleDays !== undefined) skip(`Expected whole days, got ${JSON.stringify(staleDays)}`, 'staleDays', staleDays);

  if (typeof projectsFolder === 'string') file.folder = projectsFolder;
  else if (projectsFolder !== undefined) skip('Expected a folder path', 'projectsFolder', projectsFolder);

  if (timer !== undefined) {
    const since = isObject(timer) && typeof timer.since === 'string' ? Date.parse(timer.since) : Number.NaN;
    if (isObject(timer) && typeof timer.id === 'string' && !Number.isNaN(since)) file.timer = { id: timer.id, since };
    else skip('Skipped a timer it could not read', 'timer', timer);
  }

  if (Array.isArray(order)) {
    file.order = order.filter(id => typeof id === 'string');
    for (const id of order) if (typeof id !== 'string') skip(`Skipped ${JSON.stringify(id)}`, 'order', id);
  } else if (order !== undefined) skip('Expected a list', 'order', order);

  return { file, warnings };
}
