import { analyze, depError, editLog, iso, kids, logHours as engineLog, setLeft, setTotal as engineTotal, updatePlan as enginePlan, type Analysis, type Day, type Item, type Scope, type State } from '../engine';

/**
 * One user edit. Changes the state it is given, a copy, and returns the label for the status bar and
 * the Undo button. Returning nothing means nothing happened. `store.apply` does the rest: note and
 * state.json writes, the undo entry, listeners.
 */
export type Edit = (st: State) => string | void;

const num = (n: number) => String(Math.round(n * 100) / 100);

/** The first hours a draft gets are its original estimate. Later edits leave that alone. */
function firstEstimate(it: Item, hours: number) {
  if (hours > 0 && !(it.est! > 0) && !(it.spent! > 0)) it.est = hours;
}

export const setTotal =
  (id: string, hours: number): Edit =>
  st => {
    const it = st.items[id];
    if (!it) return;
    firstEstimate(it, hours);
    engineTotal(it, hours, st.today);
    return `${it.title}: ${num(hours)}h total`;
  };

export const setHoursLeft =
  (id: string, hours: number): Edit =>
  st => {
    const it = st.items[id];
    if (!it) return;
    firstEstimate(it, hours);
    setLeft(it, hours, st.today);
    return `${it.title}: ${num(hours)}h left`;
  };

export const logHours =
  (id: string, day: Day, hours: number): Edit =>
  st => {
    const it = st.items[id];
    if (!it || !(hours > 0)) return;
    engineLog(it, day, hours, st.today);
    return `Logged ${num(hours)}h on ${it.title}`;
  };

export const editLogEntry =
  (id: string, index: number, hours: number): Edit =>
  st => {
    const it = st.items[id];
    if (!it?.log?.[index]) return;
    editLog(it, index, Math.max(0, hours), st.today);
    return hours > 0 ? `${it.title}: corrected log entry` : `${it.title}: deleted log entry, hours returned to left`;
  };

export const deleteLogEntry = (id: string, index: number): Edit => editLogEntry(id, index, 0);

/** Null sets the edge to Auto. Pinning past the other pin stops at it. */
export const setPin =
  (id: string, edge: 'start' | 'end', day: Day | null): Edit =>
  st => {
    const it = st.items[id];
    if (!it) return;
    if (edge === 'start') {
      if (day == null) delete it.pinS;
      else it.pinS = it.pinE != null ? Math.min(day, it.pinE) : day;
    } else if (day == null) delete it.pinE;
    else it.pinE = it.pinS != null ? Math.max(day, it.pinS) : day;
    const pin = edge === 'start' ? it.pinS : it.pinE;
    return `${it.title}: ${edge} ${pin == null ? 'Auto' : `pinned to ${iso(pin)}`}`;
  };

/** What a bar drag leaves: the edges it moved, pinned. */
export const setPins =
  (id: string, pins: { s?: Day; e?: Day }): Edit =>
  st => {
    const it = st.items[id];
    if (!it) return;
    if (pins.s != null) it.pinS = pins.s;
    if (pins.e != null) it.pinE = pins.e;
    return it.kind === 'ext' ? `${it.title}: dates changed` : `Dragged ${it.title}`;
  };

export const setDeadline =
  (id: string, day: Day | null): Edit =>
  st => {
    const it = st.items[id];
    if (!it) return;
    if (day == null) delete it.deadline;
    else it.deadline = day;
    return `${it.title}: deadline ${day == null ? 'cleared' : iso(day)}`;
  };

export const setBudget =
  (id: string, hours: number | null): Edit =>
  st => {
    const it = st.items[id];
    if (!it) return;
    if (hours == null) delete it.budget;
    else it.budget = hours;
    return `${it.title}: budget ${hours == null ? 'cleared' : `${num(hours)}h`}`;
  };

export const setScope =
  (id: string, scope: Scope): Edit =>
  st => {
    const it = st.items[id];
    if (!it) return;
    it.scope = scope;
    return `${it.title} is ${scope}`;
  };

export const addDep =
  (id: string, dep: string): Edit =>
  st => {
    if (depError(st, id, dep)) return;
    const it = st.items[id];
    (it.deps ||= []).push(dep);
    return `${it.title} now waits for ${st.items[dep].title}`;
  };

export const removeDep =
  (id: string, dep: string): Edit =>
  st => {
    const it = st.items[id];
    if (!it?.deps?.includes(dep)) return;
    it.deps = it.deps.filter(d => d !== dep);
    return `${it.title} no longer waits for ${st.items[dep]?.title ?? dep}`;
  };

export const setWeekly =
  (hours: number): Edit =>
  st => {
    if (!(hours > 0)) return;
    st.settings.weekly = hours;
    return `Capacity ${num(hours)}h/week`;
  };

/** Null clears the override. 0 is an override. */
export const setWeekCapacity =
  (week: number, hours: number | null): Edit =>
  st => {
    const cap = { ...st.settings.weekCap };
    if (hours == null) delete cap[week];
    else cap[week] = hours;
    st.settings.weekCap = cap;
    return hours == null ? 'Week override cleared' : `Week override ${num(hours)}h`;
  };

/** The chosen rows take the forecast as their plan. `deep` takes their sub-levels too. */
export const updatePlan =
  (ids: string[], deep: boolean): Edit =>
  st => {
    const n = enginePlan(st, analyze(st), ids.filter(id => st.items[id]), deep);
    return n ? `Plan updated on ${n} item${n > 1 ? 's' : ''}` : undefined;
  };

/** Logged but not started. Cheap, so `analyze` only runs when something qualifies. */
export const awaitsStart = (it: Item): boolean => it.kind === 'item' && it.spent! > 0 && it.actualStart == null;

/**
 * Dates that are facts, not forecasts. A task with hours logged has started once today reaches its
 * forecast start: on its first log entry from then on, else on that day. A milestone is done once
 * its date has passed.
 */
export function recordDates(st: State, a: Analysis = analyze(st)): void {
  const K = kids(st);
  for (const [id, it] of Object.entries(st.items)) {
    const b = a.by[id];
    if (!b) continue;
    if (awaitsStart(it) && !K[id] && b.start != null && b.start <= st.today) {
      const first = it.log?.find(e => e.d >= b.start!)?.d ?? b.start;
      it.actualStart = Math.min(first, st.today);
    }
    if (it.kind === 'ms' && !it.done && b.done && b.end != null) {
      it.done = true;
      it.doneOn = b.end;
    }
  }
}
