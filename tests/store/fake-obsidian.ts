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
}

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
  stateJson: string | null = null;
  private vaultEvents = new Emitter();
  private cacheEvents = new Emitter();

  readonly app = {
    vault: {
      getMarkdownFiles: () => [...this.notes.values()].map(n => n.file),
      cachedRead: async (file: FakeFile) => {
        this.reads.push(file.path);
        return this.notes.get(file.path)!.body;
      },
      on: (n: string, cb: Callback) => this.vaultEvents.on(n, cb),
      offref: (r: object) => this.vaultEvents.offref(r),
      adapter: {
        exists: async (path: string) => path === '_taskmaster/state.json' && this.stateJson != null,
        read: async (path: string) => {
          this.reads.push(path);
          return this.stateJson!;
        },
      },
    },
    metadataCache: {
      getFileCache: (file: FakeFile) => this.notes.get(file.path)?.cache ?? null,
      getFirstLinkpathDest: (linkpath: string) => this.resolve(linkpath),
      on: (n: string, cb: Callback) => this.cacheEvents.on(n, cb),
      offref: (r: object) => this.cacheEvents.offref(r),
    },
  } as unknown as StoreApp;

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
    this.add(path, frontmatter, listItems, body);
    const n = this.notes.get(path)!;
    this.cacheEvents.emit('changed', n.file, body, n.cache);
  }

  rename(oldPath: string, newPath: string) {
    const n = this.notes.get(oldPath)!;
    this.notes.delete(oldPath);
    n.file = fileAt(newPath);
    this.notes.set(newPath, n);
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
