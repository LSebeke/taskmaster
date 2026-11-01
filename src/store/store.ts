import type { EventRef } from 'obsidian';
import { dayOf, ensureTiers, type Day, type State, type Todo } from '../engine';
import type { StoreApp, StoreWarning } from './ports';
import { projectNotes } from './project';
import { defaultStateFile, parseStateFile, STATE_PATH } from './state-file';

const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[.\]\s*/;

export interface StoreOptions {
  /** Setting, default `Projects/`. */
  projectsFolder?: string;
  staleDays?: number;
  /** Quiet time collected into one recompute. */
  debounceMs?: number;
  today?: () => Day;
}

export type StoreListener = (state: State) => void;

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

/** Plan entries, history and levels are keyed by note path. A folder rename moves everything under it. */
function rewritePaths(st: State, from: string, to: string) {
  const move = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
  const moveKeys = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [move(k), v]));
  st.tiers = st.tiers.map(level => level.map(move));
  st.plan = moveKeys(st.plan);
  for (const h of st.planHistory ?? []) {
    h.ids = h.ids.map(move);
    h.before = moveKeys(h.before);
  }
}

/**
 * Owns the engine State: notes projected from the metadata cache, the rest from state.json.
 * Reads only for now. Consumers hold `state`, run the engine on it and re-run on `subscribe`.
 */
export class TaskmasterStore {
  private st: State;
  private noteWarnings: StoreWarning[] = [];
  private fileWarnings: StoreWarning[] = [];
  private folder: string;
  private debounceMs: number;
  private today: () => Day;
  private listeners = new Set<StoreListener>();
  private unhook: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** What listeners last saw. A cache event that changes nothing stays silent, which also absorbs our own writes. */
  private seen = '';
  private disposed = false;

  constructor(
    private app: StoreApp,
    opts: StoreOptions = {},
  ) {
    this.folder = folderPrefix(opts.projectsFolder ?? 'Projects/');
    this.debounceMs = opts.debounceMs ?? 100;
    this.today = opts.today ?? localToday;
    const { weekly, holidays, ...rest } = defaultStateFile();
    this.st = { ...rest, items: {}, today: 0, settings: { weekly, holidays, staleDays: opts.staleDays ?? 7 } };
  }

  get state(): State {
    return this.st;
  }

  /** What was skipped while reading notes and state.json. */
  get warnings(): StoreWarning[] {
    return [...this.fileWarnings, ...this.noteWarnings];
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
      const { file, warnings } = parseStateFile(raw);
      this.fileWarnings.push(...warnings);
      const { weekly, holidays, ...rest } = file;
      Object.assign(this.st, rest);
      Object.assign(this.st.settings, { weekly, holidays });
    }
    this.hookEvents();
    this.recompute();
  }

  /** To-dos with their text. The cache knows only the checkbox, so this reads the note: for panels, never boot. */
  async readTodos(id: string): Promise<Todo[]> {
    const file = this.app.vault.getMarkdownFiles().find(f => f.path === id);
    if (!file) return [];
    const list = this.app.metadataCache.getFileCache(file)?.listItems ?? [];
    const text = await this.app.vault.cachedRead(file);
    return list
      .filter(l => l.task !== undefined)
      .map(l => ({
        t: text.slice(l.position.start.offset, l.position.end.offset).split('\n')[0].replace(CHECKBOX, ''),
        done: l.task !== ' ',
      }));
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.unhook.forEach(off => off());
    this.unhook = [];
    this.listeners.clear();
  }

  private async readStateFile(): Promise<string | null> {
    const { adapter } = this.app.vault;
    try {
      return (await adapter.exists(STATE_PATH)) ? await adapter.read(STATE_PATH) : null;
    } catch (e) {
      this.fileWarnings.push({ path: STATE_PATH, msg: `Could not read: ${String(e)}. Using defaults` });
      return null;
    }
  }

  private hookEvents() {
    const { vault, metadataCache } = this.app;
    const hook = (source: { offref(ref: EventRef): void }, ref: EventRef) => this.unhook.push(() => source.offref(ref));
    hook(
      metadataCache,
      metadataCache.on('changed', file => {
        if (file.path.startsWith(this.folder)) this.schedule();
      }),
    );
    // Delete and rename also hit notes outside the folder, which tm-notes may link to.
    hook(
      metadataCache,
      metadataCache.on('deleted', () => this.schedule()),
    );
    hook(
      vault,
      vault.on('rename', (file, oldPath) => {
        // At once, not at the recompute: a second rename may follow within the window.
        rewritePaths(this.st, oldPath, file.path);
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

  private recompute() {
    const { items, warnings, pending } = projectNotes(this.app, this.folder);
    this.st.items = items;
    this.st.today = this.today();
    this.noteWarnings = warnings;
    // While the cache is still indexing, a task it has not reached would lose its level for good.
    if (!pending) ensureTiers(this.st);

    const now = JSON.stringify([items, this.st.tiers, this.st.today, warnings]);
    if (now === this.seen) return;
    this.seen = now;
    for (const l of this.listeners) l(this.st);
  }
}
