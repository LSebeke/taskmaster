import type { StoreApp } from '../../src/store';

type Frontmatter = Record<string, unknown>;
type Callback = (...args: unknown[]) => void;

interface FakeFile {
  path: string;
  basename: string;
  extension: string;
}

interface FakeNote {
  file: FakeFile;
  /** null: file exists but the cache has not indexed it yet. */
  cache: { frontmatter?: Frontmatter; listItems?: unknown[] } | null;
  body: string;
  /** Frontmatter as written, ahead of the cache until the echo arrives. */
  disk?: Frontmatter;
}

const STATE_PATH = '_taskmaster/state.json';

class Emitter {
  private refs = new Map<object, { name: string; cb: Callback }>();
  on(name: string, cb: Callback) {
    const ref = {};
    this.refs.set(ref, { name, cb });
    return ref;
  }
  offref(ref: object) {
    this.refs.delete(ref);
  }
  emit(name: string, ...args: unknown[]) {
    for (const r of this.refs.values()) if (r.name === name) r.cb(...args);
  }
  get listeners() {
    return this.refs.size;
  }
}

const fileAt = (path: string): FakeFile => ({
  path,
  basename: path.split('/').pop()!.replace(/\.[^.]*$/, ''),
  extension: path.split('.').pop()!,
});

/** Vault, metadata cache and adapter: the Obsidian surface the store touches, and nothing else. */
export class FakeObsidian {
  readonly notes = new Map<string, FakeNote>();
  /** Every path read from disk, by any route. */
  readonly reads: string[] = [];
  /** Files outside the markdown set, by path. */
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  /** Every processFrontMatter and vault.process that ran, in order. */
  readonly writes: { path: string; frontmatter?: Frontmatter; body?: string }[] = [];
  /** Every path written through the adapter, in order. */
  readonly adapterWrites: string[] = [];
  /** Delay before the cache reports a write. Null: only `deliver` reports it. */
  echoMs: number | null = null;
  /** Makes the next note write reject. */
  failNextWrite = false;
  private awaiting = new Set<string>();
  private vaultEvents = new Emitter();
  private cacheEvents = new Emitter();

  readonly app = {
    vault: {
      getMarkdownFiles: () => [...this.notes.values()].map(n => n.file),
      getFileByPath: (path: string) => this.notes.get(path)?.file ?? null,
      cachedRead: async (file: FakeFile) => {
        this.reads.push(file.path);
        return this.notes.get(file.path)!.body;
      },
      process: async (file: FakeFile, fn: (text: string) => string) => {
        const n = this.written(file);
        const body = fn(n.body);
        this.writes.push({ path: file.path, body });
        if (body !== n.body) this.echoLater(file.path);
        n.body = body;
        return body;
      },
      on: (n: string, cb: Callback) => this.vaultEvents.on(n, cb),
      offref: (r: object) => this.vaultEvents.offref(r),
      adapter: {
        exists: async (path: string) => this.files.has(path) || this.folders.has(path),
        read: async (path: string) => {
          this.reads.push(path);
          return this.files.get(path)!;
        },
        mkdir: async (path: string) => void this.folders.add(path),
        write: async (path: string, data: string) => {
          const dir = path.split('/').slice(0, -1).join('/');
          if (dir && !this.folders.has(dir)) throw new Error(`No folder ${dir}`);
          this.adapterWrites.push(path);
          this.files.set(path, data);
        },
        // As strict as a real adapter can be: an existing destination is refused.
        rename: async (from: string, to: string) => {
          if (this.files.has(to)) throw new Error('Destination file already exists!');
          this.files.set(to, this.files.get(from)!);
          this.files.delete(from);
        },
        remove: async (path: string) => void this.files.delete(path),
      },
    },
    fileManager: {
      processFrontMatter: async (file: FakeFile, fn: (fm: Frontmatter) => void) => {
        const n = this.written(file);
        const fm = structuredClone(n.disk ?? n.cache?.frontmatter ?? {});
        const was = JSON.stringify(fm);
        fn(fm);
        this.writes.push({ path: file.path, frontmatter: fm });
        if (JSON.stringify(fm) === was) return;
        n.disk = fm;
        this.echoLater(file.path);
      },
    },
    metadataCache: {
      getFileCache: (file: FakeFile) => this.notes.get(file.path)?.cache ?? null,
      getFirstLinkpathDest: (linkpath: string) => this.resolve(linkpath),
      fileToLinktext: (file: FakeFile) => {
        const same = [...this.notes.values()].filter(n => n.file.basename === file.basename);
        return same.length > 1 ? file.path.replace(/\.md$/, '') : file.basename;
      },
      on: (n: string, cb: Callback) => this.cacheEvents.on(n, cb),
      offref: (r: object) => this.cacheEvents.offref(r),
    },
  } as unknown as StoreApp;

  get stateJson(): string | null {
    return this.files.get(STATE_PATH) ?? null;
  }

  set stateJson(v: string | null) {
    this.folders.add('_taskmaster');
    if (v == null) this.files.delete(STATE_PATH);
    else this.files.set(STATE_PATH, v);
  }

  private written(file: FakeFile): FakeNote {
    const n = this.notes.get(file.path);
    if (!n) throw new Error(`No file ${file.path}`);
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('Disk full');
    }
    return n;
  }

  private echoLater(path: string) {
    this.awaiting.add(path);
    if (this.echoMs != null) setTimeout(() => this.deliver(), this.echoMs);
  }

  /** The cache catches up with every write so far, each note firing `changed`. */
  deliver() {
    const paths = [...this.awaiting];
    this.awaiting.clear();
    for (const path of paths) {
      const n = this.notes.get(path);
      if (!n) continue;
      n.cache = { ...n.cache, frontmatter: n.disk ?? n.cache?.frontmatter };
      this.emitChanged(path);
    }
  }

  /** Fires `changed` for what the cache holds now. */
  emitChanged(path: string) {
    const n = this.notes.get(path)!;
    this.cacheEvents.emit('changed', n.file, n.body, n.cache);
  }

  /** Current frontmatter on disk. */
  frontmatter(path: string): Frontmatter {
    const n = this.notes.get(path)!;
    return n.disk ?? n.cache?.frontmatter ?? {};
  }

  /** Exact path, else unique basename: enough of Obsidian's link resolution for tests. */
  private resolve(linkpath: string): FakeFile | null {
    const files = [...this.notes.values()].map(n => n.file);
    return (
      files.find(f => f.path === linkpath || f.path === `${linkpath}.md`) ??
      files.find(f => f.basename === linkpath) ??
      null
    );
  }

  get listenerCount() {
    return this.vaultEvents.listeners + this.cacheEvents.listeners;
  }

  /** Seeds a note without firing events, as at boot. */
  add(path: string, frontmatter?: Frontmatter, listItems?: unknown[], body = '') {
    const cache = { ...(frontmatter && { frontmatter }), ...(listItems && { listItems }) };
    this.notes.set(path, { file: fileAt(path), cache, body });
  }

  /** File is on disk, cache has not reached it. */
  addUnindexed(path: string) {
    this.notes.set(path, { file: fileAt(path), cache: null, body: '' });
  }

  /** Cache (re)indexes a note. */
  change(path: string, frontmatter?: Frontmatter, listItems?: unknown[], body = '') {
    this.awaiting.delete(path);
    this.add(path, frontmatter, listItems, body);
    this.emitChanged(path);
  }

  rename(oldPath: string, newPath: string) {
    const n = this.notes.get(oldPath)!;
    this.notes.delete(oldPath);
    n.file = fileAt(newPath);
    this.notes.set(newPath, n);
    if (this.awaiting.delete(oldPath)) this.awaiting.add(newPath);
    this.vaultEvents.emit('rename', n.file, oldPath);
  }

  /** Renames a folder and its notes. Fires for the folder only, the harshest order. */
  renameFolder(oldPath: string, newPath: string) {
    for (const [p, n] of [...this.notes]) {
      if (!p.startsWith(`${oldPath}/`)) continue;
      this.notes.delete(p);
      n.file = fileAt(newPath + p.slice(oldPath.length));
      this.notes.set(n.file.path, n);
    }
    this.vaultEvents.emit('rename', { path: newPath, name: newPath.split('/').pop() }, oldPath);
  }

  remove(path: string) {
    const n = this.notes.get(path)!;
    this.notes.delete(path);
    this.cacheEvents.emit('deleted', n.file, n.cache);
  }
}
