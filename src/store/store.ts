import type { EventRef } from 'obsidian';
import { dayOf, ensureTiers, type Day, type State, type Todo } from '../engine';
import { awaitsStart, recordDates, type Edit } from './edits';
import { notePatches } from './patch';
import type { StoreApp, StoreWarning } from './ports';
import { projectNotes } from './project';
import { defaultStateFile, parseStateFile, serializeState, STATE_BAD, STATE_PATH, STATE_TMP, writeStateAtomically } from './state-file';
import { addToText, parseTodos, removeFromText, tickInText } from './todos';
import { NoteWriter, type Patch } from './writer';

/** One to-do edit: on the projected list, shown at once, and on the note's text, later. */
interface TodoChange {
  list(todos: Todo[]): Todo[];
  text(text: string): string;
}
/** How often to look for a new day while nothing else happens. */
const CLOCK_MS = 60_000;

export interface StoreOptions {
  /** Setting, default `Projects/`. */
  projectsFolder?: string;
  staleDays?: number;
  /** Quiet time collected into one recompute. */
  debounceMs?: number;
  /** Window collecting writes to one file, and to state.json. */
  writeMs?: number;
  today?: () => Day;
}

/** `label` names the local edit behind the change. Absent: the notes changed on their own. */
export type StoreListener = (state: State, label?: string) => void;

/** One step on the session's undo stack. `store.apply` makes these; file work records its own. */
export interface UndoStep {
  label: string;
  undo(): void | Promise<void>;
  /** A note or folder was renamed: update any paths the step holds. */
  moved?(from: string, to: string): void;
}

const localToday = (): Day => {
  const n = new Date();
  const pad = (x: number) => String(x).padStart(2, '0');
  return dayOf(`${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`);
};

/** With trailing slash, so `Projects` does not also match `Projects old/`. Empty: whole vault. */
const folderPrefix = (f: string) => {
  const t = f.replace(/^\/+|\/+$/g, '');
  return t ? `${t}/` : '';
};

/** What state.json holds, as engine values. */
interface StateParts {
  tiers: State['tiers'];
  plan: State['plan'];
  planHistory: State['planHistory'];
  weekly: number;
  weekCap: State['settings']['weekCap'];
  holidays: Day[];
}

const partsOf = ({ tiers, plan, planHistory, settings: { weekly, weekCap, holidays } }: State): StateParts =>
  structuredClone({ tiers, plan, planHistory, weekly, weekCap, holidays });

function assignParts(st: State, p: Partial<StateParts>) {
  const { weekly, weekCap, holidays, ...rest } = p;
  Object.assign(st, rest);
  if ('weekly' in p) st.settings.weekly = weekly!;
  if ('weekCap' in p) st.settings.weekCap = weekCap;
  if ('holidays' in p) st.settings.holidays = holidays!;
}

/** Parts of `before` that differ from `after`. */
function changedParts(before: StateParts, after: StateParts): Partial<StateParts> {
  const keys = Object.keys(before) as (keyof StateParts)[];
  const changed = keys.filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  return Object.fromEntries(changed.map(k => [k, before[k]]));
}

const movedPath = (p: string, from: string, to: string) => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);

/** Plan entries, history and levels are keyed by note path. A folder rename moves everything under it. */
function rewritePaths(p: Pick<Partial<StateParts>, 'tiers' | 'plan' | 'planHistory'>, from: string, to: string) {
  const move = (x: string) => movedPath(x, from, to);
  const moveKeys = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [move(k), v]));
  if (p.tiers) p.tiers = p.tiers.map(level => level.map(move));
  if (p.plan) p.plan = moveKeys(p.plan);
  for (const h of p.planHistory ?? []) {
    h.ids = h.ids.map(move);
    h.before = moveKeys(h.before);
  }
}

/**
 * Owns the engine State: notes projected from the metadata cache, the rest from state.json. Consumers
 * hold `state`, run the engine on it and re-run on `subscribe`.
 *
 * Every change goes through `apply`. Items are never changed directly: an edit becomes frontmatter
 * patches, and the state is the projection of the notes with those patches laid over. So an edit
 * shows at once, in exactly the form the note will hold, and the cache's echo changes nothing.
 */
export class TaskmasterStore {
  private st: State;
  private noteWarnings: StoreWarning[] = [];
  private fileWarnings: StoreWarning[] = [];
  private folder: string;
  private debounceMs: number;
  private writeMs: number;
  private today: () => Day;
  private writes: NoteWriter;
  private listeners = new Set<StoreListener>();
  private unhook: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private stateBusy: Promise<void> = Promise.resolve();
  private clock: ReturnType<typeof setInterval> | null = null;
  private datesTimer: ReturnType<typeof setTimeout> | null = null;
  /** Day the dates were last recorded for. */
  private datesDay: Day | null = null;
  /** Latest projection saw a note the cache has not reached. */
  private pending = false;
  private stack: UndoStep[] = [];
  /** What listeners last saw. A cache event that changes nothing stays silent, which also absorbs our own writes. */
  private seen = '';
  /** To-dos as edited, until the cache has them. Its list items lag the note. */
  private todoOverlay = new Map<string, Todo[]>();
  private disposed = false;

  constructor(
    private app: StoreApp,
    opts: StoreOptions = {},
  ) {
    this.folder = folderPrefix(opts.projectsFolder ?? 'Projects/');
    this.debounceMs = opts.debounceMs ?? 100;
    this.writeMs = opts.writeMs ?? 300;
    this.today = opts.today ?? localToday;
    this.writes = new NoteWriter(app, this.writeMs, (path, e) => this.writeFailed(path, e), path => this.todosSettled(path));
    const { weekly, weekCap, holidays, ...rest } = defaultStateFile();
    this.st = { ...rest, items: {}, today: 0, settings: { weekly, weekCap, holidays, staleDays: opts.staleDays ?? 7 } };
  }

  get state(): State {
    return this.st;
  }

  /** What was skipped while reading notes and state.json. */
  get warnings(): StoreWarning[] {
    return [...this.fileWarnings, ...this.noteWarnings];
  }

  /** Label of the edit Undo would revert, or null. */
  get undoLabel(): string | null {
    return this.stack.at(-1)?.label ?? null;
  }

  /** Called after every recompute that changed something. Returns the unsubscribe. */
  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reads state.json, projects the notes and starts following the cache. Never rejects. */
  async load(): Promise<void> {
    const raw = await this.readStateFile();
    if (this.disposed) return;
    if (raw != null) {
      const { file, warnings, broken } = parseStateFile(raw);
      this.fileWarnings.push(...warnings);
      if (broken) await this.app.vault.adapter.write(STATE_BAD, raw).catch(() => undefined);
      const { weekly, weekCap, holidays, ...rest } = file;
      Object.assign(this.st, rest);
      Object.assign(this.st.settings, { weekly, weekCap, holidays });
    }
    this.hookEvents();
    this.clock = setInterval(() => {
      if (this.today() !== this.st.today) this.recompute();
    }, CLOCK_MS);
    this.recompute();
  }

  /**
   * Makes an edit, the one way anything changes. Shown at once, written debounced, undoable. Returns
   * false if the edit did nothing.
   */
  apply(edit: Edit): boolean {
    const before = partsOf(this.st);
    const staged = this.stage(edit);
    if (!staged) return false;
    const { label, notes } = staged;
    // Logging can be what starts a task, and undoing the log must undo that too.
    const starts = [...notes.keys()].some(id => this.st.items[id] && awaitsStart(this.st.items[id]));
    if (starts) {
      const dates = this.stage(st => (recordDates(st), label));
      for (const [path, patch] of dates?.notes ?? []) notes.set(path, { ...patch, ...notes.get(path) });
    }
    const parts = changedParts(before, partsOf(this.st));
    if (!notes.size && !Object.keys(parts).length) return false;
    if (Object.keys(parts).length) this.saveState();
    this.record(this.undoStep(label, notes, parts));
    this.publish(label);
    return true;
  }

  /** Reverts the last edit. Resolves to its label, or null with nothing to undo. */
  async undo(): Promise<string | null> {
    const step = this.stack.pop();
    if (!step) return null;
    await step.undo();
    return step.label;
  }

  /** Adds a step for work `apply` cannot see: creating, renaming or trashing files. */
  record(step: UndoStep) {
    this.stack.push(step);
  }

  /** Everything `fn` applies or records becomes one undo step. */
  async group(label: string, fn: () => void | Promise<void>): Promise<void> {
    const mark = this.stack.length;
    await fn();
    const steps = this.stack.splice(mark);
    if (!steps.length) return;
    this.stack.push({
      label,
      undo: async () => {
        for (const s of steps.reverse()) await s.undo();
      },
      moved: (from, to) => steps.forEach(s => s.moved?.(from, to)),
    });
  }

  /** Rewrites a note's body through `vault.process`, in the same debounced queue as frontmatter. */
  editBody(path: string, edit: (text: string) => string) {
    this.writes.editBody(path, edit);
  }

  /** Ticks or unticks to-do `index`, whose text the panel read as `t`. */
  setTodoDone(id: string, index: number, t: string, done: boolean): boolean {
    const list = this.st.items[id]?.todos;
    if (!list?.[index] || list[index].done === done) return false;
    const change = (d: boolean): TodoChange => ({
      list: todos => todos.map((x, i) => (i === index ? { ...x, done: d } : x)),
      text: text => tickInText(text, index, t, d),
    });
    this.changeTodos(id, `${done ? 'Ticked' : 'Unticked'} ${t}`, change(done), change(!done));
    return true;
  }

  /** Adds an unticked to-do after the last one. Blank text does nothing. */
  addTodo(id: string, text: string): boolean {
    const t = text.trim();
    const list = this.st.items[id]?.todos;
    if (!t || !list) return false;
    const index = list.length;
    this.changeTodos(
      id,
      `Added to-do ${t}`,
      { list: todos => [...todos, { t: '', done: false }], text: x => addToText(x, t) },
      { list: todos => todos.filter((_, i) => i !== index), text: x => removeFromText(x, index, t) },
    );
    return true;
  }

  /** Writes everything waiting, now. */
  async flush(): Promise<void> {
    const state = this.stateTimer != null ? this.writeState() : Promise.resolve();
    await Promise.all([this.writes.flush(), state, this.stateBusy]);
  }

  /** To-dos with their text, from the note: the cache has only the checkbox and lags writes. For panels, never boot. */
  async readTodos(id: string): Promise<Todo[]> {
    const file = this.app.vault.getFileByPath(id);
    if (!file) return [];
    return parseTodos(this.writes.withBodyEdits(id, await this.app.vault.cachedRead(file)));
  }

  dispose(): void {
    void this.flush();
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.datesTimer !== null) clearTimeout(this.datesTimer);
    if (this.clock !== null) clearInterval(this.clock);
    this.timer = null;
    this.unhook.forEach(off => off());
    this.unhook = [];
    this.listeners.clear();
  }

  private async readStateFile(): Promise<string | null> {
    const { adapter } = this.app.vault;
    try {
      if (await adapter.exists(STATE_PATH)) return await adapter.read(STATE_PATH);
      // A swap that never finished: the new file is whole.
      return (await adapter.exists(STATE_TMP)) ? await adapter.read(STATE_TMP) : null;
    } catch (e) {
      this.fileWarnings.push({ path: STATE_PATH, msg: `Could not read: ${String(e)}. Using defaults` });
      return null;
    }
  }

  private changeTodos(id: string, label: string, change: TodoChange, inverse: TodoChange) {
    let held = id;
    this.writeTodos(id, change);
    this.record({
      label,
      undo: () => {
        if (!this.st.items[held]) return;
        this.writeTodos(held, inverse);
        this.publish(`Undid: ${label}`);
      },
      moved: (from, to) => {
        held = movedPath(held, from, to);
      },
    });
    this.publish(label);
  }

  private writeTodos(id: string, change: TodoChange) {
    this.todoOverlay.set(id, change.list(this.st.items[id].todos ?? []));
    this.writes.editBody(id, change.text);
    this.project();
  }

  /** Nothing more is coming for this note, so the cache's list stands. */
  private todosSettled(path: string) {
    if (this.disposed || this.writes.bodyBusy(path) || !this.todoOverlay.delete(path)) return;
    this.schedule();
  }

  private frontmatterOf(path: string): Patch {
    const file = this.app.vault.getFileByPath(path);
    const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    return { ...fm, ...this.writes.overlay(path) };
  }

  /** Runs an edit on a copy, queues its writes and reprojects, without telling anyone. Returns what would undo the notes. */
  private stage(edit: Edit): { label: string; notes: Map<string, Patch> } | null {
    const draft = structuredClone(this.st);
    const label = edit(draft);
    if (!label) return null;
    const notes = new Map<string, Patch>();
    for (const [path, patch] of notePatches(this.app, this.st, draft, id => this.frontmatterOf(id))) {
      const fm = this.frontmatterOf(path);
      notes.set(path, Object.fromEntries(Object.keys(patch).map(k => [k, fm[k]])));
      this.writes.put(path, patch);
    }
    assignParts(this.st, partsOf(draft));
    this.project();
    return { label, notes };
  }

  private undoStep(label: string, notes: Map<string, Patch>, parts: Partial<StateParts>): UndoStep {
    let held = notes;
    return {
      label,
      undo: () => {
        for (const [path, patch] of held) if (this.app.vault.getFileByPath(path)) this.writes.put(path, patch);
        assignParts(this.st, parts);
        if (Object.keys(parts).length) this.saveState();
        this.recompute(`Undid: ${label}`);
      },
      moved: (from, to) => {
        held = new Map([...held].map(([p, patch]) => [movedPath(p, from, to), patch]));
        rewritePaths(parts, from, to);
      },
    };
  }

  private writeFailed(path: string, e: unknown) {
    if (this.disposed) return;
    const msg = `Could not save: ${String(e)}`;
    this.todoOverlay.delete(path);
    this.fileWarnings.push({ path, msg });
    this.recompute(`⚠ ${path}: ${msg}`);
  }

  private saveState() {
    this.stateTimer ??= setTimeout(() => void this.writeState(), this.writeMs);
  }

  private writeState(): Promise<void> {
    if (this.stateTimer != null) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    const json = serializeState(this.st);
    this.stateBusy = this.stateBusy
      .then(() => writeStateAtomically(this.app.vault.adapter, json))
      .catch((e: unknown) => this.writeFailed(STATE_PATH, e));
    return this.stateBusy;
  }

  private hookEvents() {
    const { vault, metadataCache } = this.app;
    const hook = (source: { offref(ref: EventRef): void }, ref: EventRef) => this.unhook.push(() => source.offref(ref));
    hook(
      metadataCache,
      metadataCache.on('changed', (file, _data, cache) => {
        this.writes.echoed(file.path, cache?.frontmatter);
        if (!this.writes.bodyBusy(file.path)) this.todoOverlay.delete(file.path);
        if (file.path.startsWith(this.folder)) this.schedule();
      }),
    );
    // Delete and rename also hit notes outside the folder, which tm-notes may link to.
    hook(
      metadataCache,
      metadataCache.on('deleted', file => {
        this.writes.drop(file.path);
        this.todoOverlay.delete(file.path);
        this.schedule();
      }),
    );
    hook(
      vault,
      vault.on('rename', (file, oldPath) => {
        // At once, not at the recompute: a second rename may follow within the window.
        const keyed = () => JSON.stringify([this.st.tiers, this.st.plan, this.st.planHistory]);
        const before = keyed();
        rewritePaths(this.st, oldPath, file.path);
        this.writes.rename(oldPath, file.path);
        this.todoOverlay = new Map([...this.todoOverlay].map(([p, t]) => [movedPath(p, oldPath, file.path), t]));
        for (const s of this.stack) s.moved?.(oldPath, file.path);
        if (keyed() !== before) this.saveState();
        this.schedule();
      }),
    );
  }

  /** The window opens on the first event and does not extend, so a steady stream cannot starve the view. */
  private schedule() {
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.recompute();
    }, this.debounceMs);
  }

  private project() {
    const { items, warnings, pending } = projectNotes(this.app, this.folder, path => this.writes.overlay(path));
    for (const [path, todos] of this.todoOverlay) if (items[path]) items[path].todos = todos;
    this.st.items = items;
    this.st.today = this.today();
    this.noteWarnings = warnings;
    this.pending = pending;
    // While the cache is still indexing, a task it has not reached would lose its level for good.
    if (!pending) ensureTiers(this.st);
  }

  private recompute(label?: string) {
    this.project();
    this.publish(label);
  }

  private publish(label?: string) {
    this.recordDatesSoon();
    const { items, tiers, plan, planHistory, today, settings } = this.st;
    const now = JSON.stringify([items, tiers, plan, planHistory, today, settings, this.warnings]);
    if (now === this.seen) return;
    this.seen = now;
    for (const l of this.listeners) l(this.st, label);
  }

  /** Once a day, off the boot path. Not undoable: these dates are facts about the calendar. */
  private recordDatesSoon() {
    if (this.pending || this.datesDay === this.st.today) return;
    this.datesTimer ??= setTimeout(() => {
      this.datesTimer = null;
      if (this.disposed || this.pending) return;
      this.datesDay = this.st.today;
      this.stage(st => (recordDates(st), 'Dates recorded'));
      this.recompute();
    }, 0);
  }
}
