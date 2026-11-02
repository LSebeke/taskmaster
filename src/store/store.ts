import type { EventRef } from 'obsidian';
import { dayOf, ensureTiers, type Day, type Item, type NewItem, type State, type Todo } from '../engine';
import { awaitsStart, recordDates, releaseParent, setFolder, startTimer, stopTimer, timerHours, type Edit } from './edits';
import { notePatches } from './patch';
import { attemptAll, movedPath, mover, type StoreApp, type StoreWarning } from './ports';
import { inOrder, projectNotes } from './project';
import { fixLinks, staleLinks, type LinkFix } from './relink';
import { assignParts, changedParts, defaultStateFile, liveParts, parseStateFile, partsOf, pathsKey, rewritePaths, serializeState, STATE_BAD, STATE_PATH, STATE_TMP, writeStateAtomically, type Kept, type StateParts } from './state-file';
import { Structure, type Done } from './structure';
import { addToText, parseTodos, removeFromText, tickInText } from './todos';
import { NoteWriter, type Patch } from './writer';

/** One to-do edit: on the projected list, shown at once, and on the note's text, later. */
interface TodoChange {
  list(todos: Todo[]): Todo[];
  text(text: string): string;
}
/** How often to look for a new day while nothing else happens. */
const CLOCK_MS = 60_000;
/** Renames remembered for links the cache has yet to catch up with. */
const ALIASES = 32;

export interface StoreOptions {
  /** Setting, default `Projects/`. */
  projectsFolder?: string;
  staleDays?: number;
  /** Quiet time collected into one recompute. */
  debounceMs?: number;
  /** Window collecting writes to one file, and to state.json. */
  writeMs?: number;
  today?: () => Day;
  /** Wall clock, for the timer. */
  now?: () => number;
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

/** Items hold paths too, and stay usable between a rename and the next projection. Returns whether any moved. */
function rekeyItems(st: State, from: string, to: string): boolean {
  const move = mover(from, to);
  const entries = Object.entries(st.items);
  if (!entries.some(([id]) => move(id) !== id)) return false;
  st.items = Object.fromEntries(
    entries.map(([id, it]): [string, Item] => [id, it]).map(([id, it]) => {
      it.parent = it.parent && move(it.parent);
      it.deps = it.deps?.map(move);
      it.notes = it.notes?.map(move);
      return [move(id), it];
    }),
  );
  return true;
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
  private debounceMs: number;
  private writeMs: number;
  private today: () => Day;
  private now: () => number;
  private writes: NoteWriter;
  private listeners = new Set<StoreListener>();
  private unhook: (() => void)[] = [];
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private stateBusy: Promise<void> = Promise.resolve();
  private clock: ReturnType<typeof setInterval> | null = null;
  private datesTimer: ReturnType<typeof setTimeout> | null = null;
  /** Day the dates were last recorded for. */
  private datesDay: Day | null = null;
  /** Latest projection saw a note the cache has not reached. */
  private pending = false;
  private stack: UndoStep[] = [];
  /** The step being undone: renames it causes still reach the steps it has yet to run. */
  private undoing: UndoStep | null = null;
  /** File work and undo run one at a time, each from the paths the last one left. */
  private queue: Promise<unknown> = Promise.resolve();
  /** While above 0, changes wait for the end of the file work behind them. */
  private holding = 0;
  /** Renames, oldest first. */
  private aliases: [string, string][] = [];
  private moveListeners = new Set<(from: string, to: string) => void>();
  private structure: Structure;
  /** What listeners last saw. A cache event that changes nothing stays silent, which also absorbs our own writes. */
  private seen = '';
  /** To-dos as edited, until the cache has them. Its list items lag the note. */
  private todoOverlay = new Map<string, Todo[]>();
  private disposed = false;
  /** Links that may still name a path their note has left. */
  private fixes: LinkFix[] = [];
  private fixTimer: ReturnType<typeof setTimeout> | null = null;
  /** state.json parts this version could not use, written back as they came. */
  private kept: Kept | undefined;
  /** state.json is unreadable and could not be copied, so nothing may overwrite it. */
  private stateHeld = false;
  /** Parents of notes deleted since the last recompute. They may have just lost their last child. */
  private orphans = new Set<string>();

  constructor(
    private app: StoreApp,
    opts: StoreOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 100;
    this.writeMs = opts.writeMs ?? 300;
    this.today = opts.today ?? localToday;
    this.now = opts.now ?? Date.now;
    this.writes = new NoteWriter(app, this.writeMs, (path, e) => this.writeFailed(path, e), path => this.todosSettled(path));
    const { weekly, weekCap, holidays, ...rest } = defaultStateFile();
    this.st = { ...rest, folder: folderPrefix(opts.projectsFolder ?? 'Projects/'), items: {}, today: 0, settings: { weekly, weekCap, holidays, staleDays: opts.staleDays ?? 7 } };
    const store = this;
    this.structure = new Structure({
      app,
      get state() {
        return store.st;
      },
      get root() {
        return store.folder.replace(/\/$/, '');
      },
      serial: fn => this.serial(fn),
      atomic: (label, fn) => this.atomic(label, fn),
      apply: edit => this.apply(edit),
      record: step => this.record(step),
      follow: path => this.follow(path),
      seed: (path, fm) => this.writes.seed(path, fm),
      drop: path => this.writes.drop(path),
      flushNotes: () => this.writes.flush(),
      frontmatterOf: path => this.frontmatterOf(path),
    });
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

  private get folder(): string {
    return this.st.folder ?? '';
  }

  /** The clock timers run on. */
  time(): number {
    return this.now();
  }

  /** Where item notes live, with trailing slash. */
  get projectsFolder(): string {
    return this.folder;
  }

  /** Items are read from here from now on. Notes stay where they are. Returns why not, or null. */
  setProjectsFolder(path: string): string | null {
    const folder = folderPrefix(path);
    const dir = folder.replace(/\/$/, '');
    if (dir && !this.app.vault.getFolderByPath(dir)) return `There is no folder ${dir}`;
    this.apply(setFolder(folder));
    return null;
  }

  /** The running timer. A timer on a note that went away counts as none. */
  get timer(): State['timer'] | null {
    const t = this.st.timer;
    return t && this.st.items[t.id] ? t : null;
  }

  /** On a task with hours left, with no timer running. Returns whether it started. */
  startTimer(id: string): boolean {
    if (this.st.timer && !this.timer) delete this.st.timer;
    return this.apply(startTimer(id, this.now()));
  }

  /** Logs the time run. Null with nothing running. */
  stopTimer(): { id: string; hours: number } | null {
    const t = this.st.timer;
    if (!t) return null;
    const running = this.timer;
    const now = this.now();
    const hours = timerHours(this.st, now);
    this.apply(stopTimer(now));
    return running ? { id: running.id, hours } : null;
  }

  /** Notes linking to an item that are not its children, its dependents or its own tm-notes. */
  backlinks(id: string): string[] {
    const it = this.st.items[id];
    if (!it) return [];
    const structure = (source: string) => {
      const s = this.st.items[source];
      return !!s && (s.parent === id || !!s.deps?.includes(id));
    };
    return Object.entries(this.app.metadataCache.resolvedLinks)
      .filter(([source, to]) => to[id] && source !== id && !it.notes?.includes(source) && !structure(source))
      .map(([source]) => source)
      .sort();
  }

  /** Adds an item: its note, and a move of the parent's note if this is its first child. */
  create(n: NewItem): Promise<Done> {
    return this.structure.create(n);
  }

  /** Moves an item under a parent (null: top level), before a sibling (null: last). */
  move(id: string, parent: string | null, before: string | null = null): Promise<Done> {
    return this.structure.move(id, parent, before);
  }

  rename(id: string, title: string): Promise<Done> {
    return this.structure.rename(id, title);
  }

  /** Deletes an item and everything inside it. */
  remove(id: string): Promise<Done> {
    return this.structure.remove(id);
  }

  /** Creates a note and links it to an item. */
  linkNew(id: string, title: string): Promise<Done> {
    return this.structure.linkNew(id, title);
  }

  /** Called on every rename, before listeners hear of any change it brings. Returns the unsubscribe. */
  onMove(listener: (from: string, to: string) => void): () => void {
    this.moveListeners.add(listener);
    return () => this.moveListeners.delete(listener);
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
      if (broken) await this.keepAside(this.app.vault.adapter.write(STATE_BAD, raw));
      const { kept, staleDays, ...parts } = file;
      this.kept = kept;
      assignParts(this.st, { ...parts, staleDays: staleDays ?? this.st.settings.staleDays });
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
  undo(): Promise<string | null> {
    return this.serial(async () => {
      const step = this.stack.pop();
      if (!step) return null;
      const failed = await this.reverse(step);
      this.recompute(failed ? `⚠ Undo incomplete: ${failed}` : `Undid: ${step.label}`);
      return step.label;
    });
  }

  /** Adds a step for work `apply` cannot see: creating, renaming or trashing files. */
  record(step: UndoStep) {
    this.stack.push(step);
  }

  /** Everything `fn` applies or records becomes one undo step. */
  async group(label: string, fn: () => void | Promise<void>): Promise<void> {
    const mark = this.stack.length;
    try {
      await fn();
    } finally {
      const steps = this.stack.splice(mark);
      if (steps.length) {
        this.stack.push({
          label,
          undo: () =>
            attemptAll(
              [...steps].reverse().map(s => () => {
                // Off the list first: renames it causes must reach only the steps still to run.
                steps.splice(steps.indexOf(s), 1);
                return s.undo();
              }),
            ),
          moved: (from, to) => steps.forEach(s => s.moved?.(from, to)),
        });
      }
    }
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
      { list: todos => [...todos, { text: '', done: false }], text: x => addToText(x, t) },
      { list: todos => todos.filter((_, i) => i !== index), text: x => removeFromText(x, index, t) },
    );
    return true;
  }

  /** Writes everything waiting, now. */
  async flush(): Promise<void> {
    this.repairLinks();
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
    if (this.waitTimer !== null) clearTimeout(this.waitTimer);
    if (this.datesTimer !== null) clearTimeout(this.datesTimer);
    if (this.fixTimer !== null) clearTimeout(this.fixTimer);
    if (this.clock !== null) clearInterval(this.clock);
    this.waitTimer = null;
    this.unhook.forEach(off => off());
    this.unhook = [];
    this.listeners.clear();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** One undo step, one change for listeners. If `fn` fails, what it did is undone and the reason returned. */
  private async atomic(label: string, fn: () => Promise<void>): Promise<string | null> {
    const mark = this.stack.length;
    let failed: string | null = null;
    this.holding++;
    try {
      await this.group(label, fn);
    } catch (e) {
      failed = String(e);
      const left = this.stack.length > mark ? await this.reverse(this.stack.pop()!) : null;
      if (left) failed += `, and undoing it stopped short: ${left}`;
    } finally {
      this.holding--;
    }
    this.recompute(failed ? `⚠ ${label}: ${failed}` : label);
    return failed;
  }

  /** Runs one undo step with listeners held back. Returns what went wrong, if anything. */
  private async reverse(step: UndoStep): Promise<string | null> {
    this.undoing = step;
    this.holding++;
    try {
      await step.undo();
      return null;
    } catch (e) {
      this.fileWarnings.push({ path: step.label, msg: `Could not undo: ${String(e)}` });
      return String(e);
    } finally {
      this.holding--;
      this.undoing = null;
    }
  }

  private follow(path: string): string {
    return this.aliases.reduce((p, [from, to]) => movedPath(p, from, to), path);
  }

  /** Links name a note by path or by bare title. Only asked about links the cache cannot resolve. */
  private aliasOf(linkpath: string): string | null {
    let path = `${linkpath}.md`;
    for (const [from, to] of this.aliases) {
      if (path === `${from.split('/').pop()}`) path = to;
      else path = movedPath(path, from, to);
    }
    return this.app.vault.getFileByPath(path) ? path : null;
  }

  private async readStateFile(): Promise<string | null> {
    const { adapter } = this.app.vault;
    try {
      if (await adapter.exists(STATE_PATH)) return await adapter.read(STATE_PATH);
      // A swap that never finished: the new file is whole.
      return (await adapter.exists(STATE_TMP)) ? await adapter.read(STATE_TMP) : null;
    } catch (e) {
      this.fileWarnings.push({ path: STATE_PATH, msg: `Could not read: ${String(e)}. Using defaults, a copy stays at ${STATE_BAD}` });
      await this.keepAside(adapter.copy(STATE_PATH, STATE_BAD));
      return null;
    }
  }

  /** A state.json the store could not take in is the only copy of its data: without a spare, nothing may replace it. */
  private async keepAside(copy: Promise<void>) {
    try {
      await copy;
    } catch (e) {
      this.stateHeld = true;
      this.fileWarnings.push({ path: STATE_BAD, msg: `Could not keep a copy: ${String(e)}. Levels, plans and settings will not be saved over ${STATE_PATH}` });
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
    if (this.stateHeld) return this.stateBusy;
    const json = serializeState(this.st, this.kept);
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
        const parent = this.st.items[file.path]?.parent;
        if (parent) this.orphans.add(parent);
        this.writes.drop(file.path);
        this.todoOverlay.delete(file.path);
        this.schedule();
      }),
    );
    hook(
      vault,
      vault.on('rename', (file, oldPath) => {
        // At once, not at the recompute: a second rename may follow within the window.
        const before = pathsKey(this.st);
        this.queueLinkFixes(oldPath, file.path);
        rewritePaths(this.st, oldPath, file.path);
        const items = rekeyItems(this.st, oldPath, file.path);
        this.writes.rename(oldPath, file.path);
        this.aliases.push([oldPath, file.path]);
        this.aliases.splice(0, this.aliases.length - ALIASES);
        this.todoOverlay = new Map([...this.todoOverlay].map(([p, t]) => [movedPath(p, oldPath, file.path), t]));
        for (const s of this.stack) s.moved?.(oldPath, file.path);
        this.undoing?.moved?.(oldPath, file.path);
        if (pathsKey(this.st) !== before) this.saveState();
        if (items) for (const l of this.moveListeners) l(oldPath, file.path);
        this.schedule();
      }),
    );
  }

  /** Obsidian's own link update may be on, off or still running, so the check waits a write window. */
  private queueLinkFixes(from: string, to: string) {
    const move = mover(from, to);
    this.fixes = [...this.fixes.map(f => ({ ...f, ref: move(f.ref), to: move(f.to) })), ...staleLinks(this.st, from, to)];
    if (this.fixes.length) this.fixTimer ??= setTimeout(() => this.repairLinks(), this.writeMs);
  }

  /** Not an edit: this keeps the notes saying what they already meant. Goes through the writer, in order with everything else. */
  private repairLinks() {
    if (this.fixTimer !== null) clearTimeout(this.fixTimer);
    this.fixTimer = null;
    const fixes = this.fixes;
    this.fixes = [];
    for (const [path, patch] of fixLinks(this.app, fixes, path => this.frontmatterOf(path))) this.writes.put(path, patch);
  }

  /** The window opens on the first event and does not extend, so a steady stream cannot starve the view. */
  private schedule() {
    this.waitTimer ??= setTimeout(() => {
      this.waitTimer = null;
      this.recompute();
    }, this.debounceMs);
  }

  private project() {
    const { items, warnings, pending } = projectNotes(this.app, this.folder, path => this.writes.overlay(path), {
      alias: link => this.aliasOf(link),
    });
    for (const [path, todos] of this.todoOverlay) if (items[path]) items[path].todos = todos;
    this.st.items = inOrder(items, this.st.order);
    this.st.today = this.today();
    this.noteWarnings = warnings;
    this.pending = pending;
    // While the cache is still indexing, a task it has not reached would lose its level for good.
    if (!pending) ensureTiers(this.st);
  }

  private recompute(label?: string) {
    this.project();
    this.settleOrphans();
    this.publish(label);
  }

  /** Not undoable: nothing here can bring back a note someone deleted. */
  private settleOrphans() {
    if (this.pending || !this.orphans.size) return;
    const ids = [...this.orphans].map(id => this.follow(id));
    this.orphans.clear();
    for (const id of ids) this.stage(releaseParent(id));
  }

  private publish(label?: string) {
    if (this.holding) return;
    this.recordDatesSoon();
    const { items, today } = this.st;
    const now = JSON.stringify([items, today, liveParts(this.st), this.warnings]);
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
