import {
  addItem,
  addTier,
  analyze,
  depError,
  editLog,
  iso,
  kids,
  logHours as engineLog,
  moveError,
  moveItem,
  moveToTier,
  removeItem,
  removeTier,
  setLeft,
  setTotal as engineTotal,
  updatePlan as enginePlan,
  type Analysis,
  type Day,
  type Item,
  type NewItem,
  type Scope,
  type State,
} from '../engine';

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

/** `level`: where a task left its level only because a timer ran past its hours, so it goes back there. */
export const setHoursLeft =
  (id: string, hours: number, level?: number | null): Edit =>
  st => {
    const it = st.items[id];
    if (!it) return;
    firstEstimate(it, hours);
    setLeft(it, hours, st.today);
    if (level != null && it.left! > 0 && !st.tiers.flat().includes(id)) st.tiers[level]?.push(id);
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
    if (it.kind === 'ext') return `${it.title}: ${edge} ${iso(pin!)}`;
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

export const setStaleDays =
  (days: number): Edit =>
  st => {
    if (!Number.isInteger(days) || days < 1) return;
    st.settings.staleDays = days;
    return `Stale after ${days} day${days > 1 ? 's' : ''}`;
  };

export const addHoliday =
  (day: Day): Edit =>
  st => {
    if (st.settings.holidays.includes(day)) return;
    st.settings.holidays = [...st.settings.holidays, day].sort((a, b) => a - b);
    return `Holiday ${iso(day)}`;
  };

export const removeHoliday =
  (day: Day): Edit =>
  st => {
    if (!st.settings.holidays.includes(day)) return;
    st.settings.holidays = st.settings.holidays.filter(d => d !== day);
    return `Holiday ${iso(day)} removed`;
  };

/** With trailing slash, as `State.folder` holds it. */
export const setFolder =
  (folder: string): Edit =>
  st => {
    st.folder = folder;
    return `Projects folder ${folder || 'is the whole vault'}`;
  };

/** Childless, a plain item, with hours left. */
const timeable = (st: State, id: string) => {
  const it = st.items[id];
  return it?.kind === 'item' && it.left! > 0 && !kids(st)[id];
};

export const startTimer =
  (id: string, now: number): Edit =>
  st => {
    if (st.timer || !timeable(st, id)) return;
    st.timer = { id, since: now };
    return `Timer started on ${st.items[id].title}`;
  };

/** Hours stopping now would log, to the hundredth. None on a task that has gained children: hours go on tasks. */
export function timerHours(st: State, now: number): number {
  const t = st.timer;
  if (!t || !st.items[t.id] || kids(st)[t.id]) return 0;
  return Math.max(0, Math.round((now - t.since) / 36_000) / 100);
}

/** Under a hundredth of an hour logs nothing. */
export const stopTimer =
  (now: number): Edit =>
  st => {
    const t = st.timer;
    if (!t) return;
    const hours = timerHours(st, now);
    delete st.timer;
    const it = st.items[t.id];
    if (!it) return 'Timer stopped';
    if (!hours) return `Timer stopped on ${it.title}, nothing to log`;
    engineLog(it, st.today, hours, st.today);
    return `Logged ${num(hours)}h on ${it.title}`;
  };

/** Notes project in path order. This keeps the order siblings have now, which a project's colour follows. */
function pinSiblings(st: State, parent: string | null) {
  const siblings = kids(st)[parent ?? ''] ?? [];
  st.order = [...(st.order ?? []).filter(x => st.items[x] && !siblings.includes(x)), ...siblings];
}

/** The state half of a new note. The note may already be in the projection, and a parent must see it arrive. */
export const addEdit =
  (n: NewItem & { id: string }): Edit =>
  st => {
    delete st.items[n.id];
    st.tiers = st.tiers.map(t => t.filter(x => x !== n.id));
    addItem(st, n);
    pinSiblings(st, n.parent ?? null);
    return `Added ${n.title}`;
  };

/** The state half of a move, once the note is in place. Siblings keep the order the drop gave them. */
export const moveEdit =
  (id: string, parent: string | null, before: string | null = null): Edit =>
  st => {
    if (!st.items[id] || moveError(st, id, parent)) return;
    moveItem(st, id, parent, before);
    pinSiblings(st, parent);
    return `Moved ${st.items[id].title}`;
  };

export const removeEdit =
  (id: string): Edit =>
  st => {
    const it = st.items[id];
    if (!it) return;
    removeItem(st, id);
    st.order = st.order?.filter(x => st.items[x]);
    if (st.timer && !st.items[st.timer.id]) delete st.timer;
    return `Deleted ${it.title}`;
  };

export const linkNote =
  (id: string, path: string): Edit =>
  st => {
    const it = st.items[id];
    if (!it || it.notes?.includes(path)) return;
    (it.notes ||= []).push(path);
    return `Linked ${path.split('/').pop()!.replace(/\.md$/, '')} to ${it.title}`;
  };

export const unlinkNote =
  (id: string, path: string): Edit =>
  st => {
    const it = st.items[id];
    if (!it?.notes?.includes(path)) return;
    it.notes = it.notes.filter(n => n !== path);
    return `Unlinked ${path.split('/').pop()!.replace(/\.md$/, '')} from ${it.title}`;
  };

/** The chosen rows take the forecast as their plan. `deep` takes their sub-levels too. */
export const updatePlan =
  (ids: string[], deep: boolean): Edit =>
  st => {
    const n = enginePlan(st, analyze(st), ids.filter(id => st.items[id]), deep);
    return n ? `Plan updated on ${n} item${n > 1 ? 's' : ''}` : undefined;
  };

/** Into level `level`, before `before`, else last. Inside its own level this only changes the order. */
export const moveTask =
  (id: string, level: number, before?: string | null): Edit =>
  st => {
    const it = st.items[id];
    const from = st.tiers.findIndex(t => t.includes(id));
    if (!it || from < 0 || !st.tiers[level]) return;
    st.tiers = moveToTier(st.tiers, id, level, before);
    return from === level ? `Reordered ${it.title}` : `Moved ${it.title} to Priority ${level + 1}`;
  };

/** A new empty level at index `at`. */
export const addLevel =
  (at: number): Edit =>
  st => {
    st.tiers = addTier(st.tiers, at);
    return 'Added a priority level';
  };

export const removeLevel =
  (at: number): Edit =>
  st => {
    if (st.tiers[at]?.length !== 0) return;
    st.tiers = removeTier(st.tiers, at);
    return 'Removed an empty priority level';
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
