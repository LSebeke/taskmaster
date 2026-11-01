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

const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');

/** Reads back what notes hold: one `key: JSON` line per field. Enough YAML for tests. */
function parseNote(data: string): { frontmatter?: Frontmatter; body: string } {
  const m = /^---\n([\s\S]*?)---\n?/.exec(data);
  if (!m) return { body: data };
  const entries = m[1].split('\n').filter(Boolean).map(line => {
    const at = line.indexOf(': ');
    return [line.slice(0, at), JSON.parse(line.slice(at + 2))];
  });
  return { frontmatter: Object.fromEntries(entries), body: data.slice(m[0].length) };
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
  /** Paths given to Obsidian's trash, in order. */
  readonly trashed: string[] = [];
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
      getFolderByPath: (path: string) => this.folder(path),
      getAbstractFileByPath: (path: string) => this.notes.get(path)?.file ?? this.folder(path),
      read: async (file: FakeFile) => {
        this.reads.push(file.path);
        return this.text(file.path);
      },
      create: async (path: string, data: string) => {
        if (this.notes.has(path) || this.folders.has(path)) throw new Error('File already exists.');
        const dir = parentOf(path);
        if (dir && !this.folders.has(dir)) throw new Error(`No folder ${dir}`);
        const { frontmatter, body } = parseNote(data);
        this.notes.set(path, { file: fileAt(path), cache: null, body, disk: frontmatter });
        this.echoLater(path);
        return this.notes.get(path)!.file;
      },
      createFolder: async (path: string) => {
        if (this.folders.has(path)) throw new Error('Folder already exists.');
        const dir = parentOf(path);
        if (dir && !this.folders.has(dir)) throw new Error(`No folder ${dir}`);
        this.folders.add(path);
        return this.folder(path);
      },
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
        exists: async (path: string) => this.files.has(path) || this.folders.has(path) || this.notes.has(path),
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
      renameFile: async (file: FakeFile, newPath: string) => {
        if (this.notes.has(newPath) || this.folders.has(newPath)) throw new Error('Destination file already exists!');
        const dir = parentOf(newPath);
        if (dir && !this.folders.has(dir)) throw new Error(`No folder ${dir}`);
        const links = this.linksTo(file.path);
        if (this.notes.has(file.path)) this.rename(file.path, newPath);
        else this.renameFolder(file.path, newPath);
        this.rewriteLinks(links, file.path, newPath);
      },
      trashFile: async (file: FakeFile) => {
        this.trashed.push(file.path);
        if (this.notes.has(file.path)) return this.remove(file.path);
        if (this.children(file.path).length) throw new Error('Fake: trash notes first');
        this.folders.delete(file.path);
      },
      getNewFileParent: () => this.folder(this.newNotesFolder),
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

  /** Folder new notes go in, per the user's setting. */
  newNotesFolder = '';

  private folder(path: string) {
    if (!this.folders.has(path)) return null;
    return { path, name: path.split('/').pop(), children: this.children(path) };
  }

  /** Files and folders directly inside a folder. */
  private children(path: string) {
    const direct = (p: string) => parentOf(p) === path;
    return [...[...this.notes.keys()].filter(direct), ...[...this.folders].filter(direct), ...[...this.files.keys()].filter(direct)].map(p => ({ path: p }));
  }

  /** Note text as it stands on disk. */
  text(path: string): string {
    const n = this.notes.get(path)!;
    const fm = n.disk ?? n.cache?.frontmatter;
    return fm ? `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}\n`).join('')}---\n${n.body}` : n.body;
  }

  /** Notes with a link leading to a path or under it, and the keys holding it. */
  private linksTo(target: string) {
    const out: { path: string; key: string }[] = [];
    const leads = (v: unknown) => {
      const m = typeof v === 'string' ? /^\[\[([^\]|#]+)/.exec(v) : null;
      const to = m ? this.resolve(m[1])?.path : undefined;
      return to === target || !!to?.startsWith(`${target}/`);
    };
    for (const [path, n] of this.notes) {
      const fm = n.disk ?? n.cache?.frontmatter ?? {};
      for (const key of Object.keys(fm)) if ([fm[key]].flat().some(leads)) out.push({ path, key });
    }
    return out;
  }

  /** As Obsidian does after a rename: frontmatter links rewritten on disk, the cache catching up later. */
  private rewriteLinks(links: { path: string; key: string }[], from: string, to: string) {
    const stem = (p: string) => p.replace(/\.md$/, '');
    const name = (p: string) => stem(p).split('/').pop()!;
    const move = (v: unknown) => {
      if (typeof v !== 'string') return v;
      const link = /^\[\[([^\]|#]+)/.exec(v)?.[1];
      if (!link) return v;
      if (link === name(from)) return `[[${name(to)}]]`;
      const full = `${stem(link)}.md`;
      if (full === from || full.startsWith(`${from}/`)) return `[[${stem(to + full.slice(from.length))}]]`;
      return v;
    };
    for (const { path, key } of links) {
      const here = path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
      const n = this.notes.get(here)!;
      const fm: Frontmatter = { ...(n.disk ?? n.cache?.frontmatter) };
      const held = fm[key];
      fm[key] = Array.isArray(held) ? held.map(move) : move(held);
      n.disk = fm;
      this.echoLater(here);
    }
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
    for (let dir = parentOf(path); dir; dir = parentOf(dir)) this.folders.add(dir);
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
    for (let dir = parentOf(newPath); dir; dir = parentOf(dir)) this.folders.add(dir);
    this.vaultEvents.emit('rename', n.file, oldPath);
  }

  /** Renames a folder and its notes. Fires for the folder only, the harshest order. */
  renameFolder(oldPath: string, newPath: string) {
    for (const [p, n] of [...this.notes]) {
      if (!p.startsWith(`${oldPath}/`)) continue;
      this.notes.delete(p);
      n.file = fileAt(newPath + p.slice(oldPath.length));
      this.notes.set(n.file.path, n);
      if (this.awaiting.delete(p)) this.awaiting.add(n.file.path);
    }
    for (const d of [...this.folders]) {
      if (d !== oldPath && !d.startsWith(`${oldPath}/`)) continue;
      this.folders.delete(d);
      this.folders.add(newPath + d.slice(oldPath.length));
    }
    this.vaultEvents.emit('rename', { path: newPath, name: newPath.split('/').pop() }, oldPath);
  }

  remove(path: string) {
    const n = this.notes.get(path)!;
    this.notes.delete(path);
    this.cacheEvents.emit('deleted', n.file, n.cache);
  }
}
