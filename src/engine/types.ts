/** Days since 1970-01-01 UTC. Every date in the engine is one of these. */
export type Day = number;

/** Whether an item is a parent, task or draft is derived. Milestone and external are stored kinds. */
export type ItemKind = 'item' | 'ms' | 'ext';
export type Scope = 'must' | 'should' | 'could';

export interface LogEntry {
  d: Day;
  h: number;
}

export interface Todo {
  t: string;
  done: boolean;
}

export interface Item {
  title: string;
  parent: string | null;
  kind: ItemKind;
  scope?: Scope;
  deps?: string[];
  todos?: Todo[];
  notes?: string[];
  est?: number;
  spent?: number;
  left?: number;
  budget?: number;
  deadline?: Day;
  pinS?: Day;
  /** A milestone's pin lives here. */
  pinE?: Day;
  actualStart?: Day | null;
  doneOn?: Day | null;
  /** Date hours left last changed. */
  touched?: Day;
  log?: LogEntry[];
  /** Milestones only: recorded as passed. */
  done?: boolean;
}

export interface PlanEntry {
  start: Day;
  end: Day;
  hours: number;
}

export interface PlanHistoryEntry {
  day: Day;
  ids: string[];
  before: Record<string, PlanEntry | undefined>;
}

export interface Settings {
  weekly: number;
  staleDays: number;
  holidays: Day[];
}

export interface State {
  items: Record<string, Item>;
  plan: Partial<Record<string, PlanEntry>>;
  /** Priority levels, highest first. */
  tiers: string[][];
  today: Day;
  settings: Settings;
  planHistory?: PlanHistoryEntry[];
  /** Counter for generated ids. */
  seq?: number;
}

/** Children per item. Top-level items sit under ''. */
export type KidsMap = Partial<Record<string, string[]>>;

export interface ScheduleOptions {
  exclude?: Set<string>;
  scale?: (id: string) => number;
}

export interface Conflict {
  /** null: not tied to one item, such as overbooking. */
  id: string | null;
  msg: string;
}

export interface ChainLink {
  a: string;
  b: string;
  kind: 'cap' | 'dep';
}

export interface ItemResult {
  start: Day | null;
  end: Day | null;
  spent: number;
  left: number;
  est: number;
  done: boolean;
  crit: boolean;
  /** Done %, as 0 to 1. */
  pct: number;
  /** Plan says today, as 0 to 1. Null without planned hours. */
  shouldPct: number | null;
  burn?: number;
  kind?: ItemKind;
  /** Task that took the hours the last time this one sat idle. */
  idleBy?: string | null;
  rel?: Day;
  draft?: boolean;
  /** Days since hours left changed, when stale. */
  stale?: number;
  /** vs plan, in working days. Positive is behind. */
  shift?: number;
  overDeadline?: number;
  planGap?: number;
  planGapH?: number;
}

/** Hours per project root, per week number. */
export type WeekLoad = Record<number, Record<string, number>>;

export interface Analysis {
  by: Record<string, ItemResult>;
  conflicts: Conflict[];
  links: ChainLink[];
  weeks: WeekLoad;
  todayH: Record<string, number>;
  K: KidsMap;
  rel: Record<string, Day>;
}
