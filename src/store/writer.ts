import type { StoreApp } from './ports';

/** Frontmatter keys to set. Undefined deletes the key. */
export type Patch = Record<string, unknown>;

type BodyEdit = (text: string) => string;

interface Slot {
  path: string;
  /** Waiting for the debounce. */
  pending: Patch;
  /** Written or being written, not yet back from the cache. */
  sent: Patch;
  /** Writes the cache has yet to report. */
  echoes: number;
  body: BodyEdit[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Writes to one file run in order. */
  busy: Promise<void>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Debounced writes per note, and the values the cache cannot know yet. The store projects notes
 * through `overlay`, so an edit shows at once and the cache's echo changes nothing.
 */
export class NoteWriter {
  private slots = new Map<string, Slot>();

  constructor(
    private app: StoreApp,
    private debounceMs: number,
    private failed: (path: string, error: unknown) => void,
  ) {}

  overlay(path: string): Patch | undefined {
    const s = this.slots.get(path);
    return s && { ...s.sent, ...s.pending };
  }

  put(path: string, patch: Patch) {
    Object.assign(this.slot(path).pending, patch);
    this.arm(path);
  }

  editBody(path: string, edit: BodyEdit) {
    this.slot(path).body.push(edit);
    this.arm(path);
  }

  /** The cache reported this note. Values it confirms stop shadowing it. */
  echoed(path: string, frontmatter: Patch | undefined) {
    const s = this.slots.get(path);
    if (!s) return;
    for (const k in s.sent) if (same(frontmatter?.[k], s.sent[k])) delete s.sent[k];
    // Every write is back: what still differs is someone else's edit, and the note wins.
    if (s.echoes > 0 && --s.echoes === 0) s.sent = {};
    this.tidy(s);
  }

  /** The note is gone. */
  drop(path: string) {
    const s = this.slots.get(path);
    if (s?.timer != null) clearTimeout(s.timer);
    this.slots.delete(path);
  }

  rename(from: string, to: string) {
    for (const [path, s] of [...this.slots]) {
      if (path !== from && !path.startsWith(`${from}/`)) continue;
      this.slots.delete(path);
      s.path = to + path.slice(from.length);
      this.slots.set(s.path, s);
    }
  }

  /** Writes everything now. */
  async flush(): Promise<void> {
    await Promise.all([...this.slots.values()].map(s => this.send(s)));
  }

  private slot(path: string): Slot {
    let s = this.slots.get(path);
    if (!s) {
      s = { path, pending: {}, sent: {}, echoes: 0, body: [], timer: null, busy: Promise.resolve() };
      this.slots.set(path, s);
    }
    return s;
  }

  /** The window opens on the first edit and does not extend, as for reads. */
  private arm(path: string) {
    const s = this.slot(path);
    s.timer ??= setTimeout(() => void this.send(s), this.debounceMs);
  }

  private send(s: Slot): Promise<void> {
    if (s.timer != null) clearTimeout(s.timer);
    s.timer = null;
    s.busy = s.busy.then(() => this.write(s));
    return s.busy;
  }

  private async write(s: Slot) {
    const { pending: patch, body } = s;
    s.pending = {};
    s.body = [];
    const keys = Object.keys(patch);
    Object.assign(s.sent, patch);
    const forget = () => {
      for (const k of keys) if (same(s.sent[k], patch[k])) delete s.sent[k];
    };
    try {
      const file = this.app.vault.getFileByPath(s.path);
      if (!file) throw new Error('Note not found');
      if (keys.length) {
        await this.app.fileManager.processFrontMatter(file, fm => {
          const changes = keys.filter(k => !same(fm[k], patch[k]));
          for (const k of changes) {
            if (patch[k] === undefined) delete fm[k];
            else fm[k] = patch[k];
          }
          // Nothing changes on disk, so no echo will ever clear these.
          if (changes.length) s.echoes++;
          else forget();
        });
      }
      if (body.length) {
        await this.app.vault.process(file, text => {
          const next = body.reduce((t, edit) => edit(t), text);
          if (next !== text) s.echoes++;
          return next;
        });
      }
    } catch (e) {
      forget();
      this.tidy(s);
      this.failed(s.path, e);
      return;
    }
    this.tidy(s);
  }

  private tidy(s: Slot) {
    const idle = s.timer == null && !s.body.length && !Object.keys(s.pending).length && !Object.keys(s.sent).length;
    if (idle && this.slots.get(s.path) === s) this.slots.delete(s.path);
  }
}
