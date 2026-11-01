import { kids, moveError, newItemError, type NewItem, type State } from '../engine';
import { addEdit, linkNote, moveEdit, removeEdit, type Edit } from './edits';
import { noteFields } from './patch';
import { movedPath, type StoreApp } from './ports';
import type { Patch } from './writer';

/** What a structural change came to. `error` says why it was refused; `id` is where the item ended up. */
export interface Done {
  id?: string;
  error?: string;
}

/** The store's side of file work. */
export interface StructureHost {
  readonly app: StoreApp;
  readonly state: State;
  /** Top of the projects folder, without trailing slash. Empty: the vault's root. */
  readonly root: string;
  /** One after the other: each step sees the paths the last one left. */
  serial<T>(fn: () => Promise<T>): Promise<T>;
  /** One undo step and one change for listeners. Failing midway rolls back and returns the reason. */
  atomic(label: string, fn: () => Promise<void>): Promise<string | null>;
  apply(edit: Edit): boolean;
  record(step: { label: string; undo(): void | Promise<void>; moved?(from: string, to: string): void }): void;
  /** Where a path has gone since it was handed out. */
  follow(path: string): string;
  /** A note just written: shows at once, ahead of the cache. */
  seed(path: string, frontmatter: Patch): void;
  /** The note is going. Waiting writes go with it. */
  drop(path: string): void;
  flushNotes(): Promise<void>;
  frontmatterOf(path: string): Patch;
}

const dirOf = (path: string) => path.split('/').slice(0, -1).join('/');
const nameOf = (path: string) => path.split('/').pop()!.replace(/\.md$/, '');
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const md = (dir: string, title: string) => `${join(dir, title)}.md`;

/** Obsidian refuses these in a file name, or they would break the `[[link]]`. */
export const safeTitle = (title: string) => title.trim().replace(/[\\/:*?"<>|#^[\]]/g, '-');

/** YAML with JSON's strings and lists, which are valid YAML. Obsidian rewrites it its own way on the next edit. */
const noteText = (fm: Patch) =>
  `---\n${Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}\n`)
    .join('')}---\n`;

/** Everything under an item, itself first. */
function subtree(st: State, id: string): string[] {
  const K = kids(st);
  const out: string[] = [];
  const walk = (i: string) => {
    out.push(i);
    (K[i] ?? []).forEach(walk);
  };
  walk(id);
  return out;
}

/** Notes, folders and links, kept in step with the items. Items are keyed by path, so most of this is keeping paths straight. */
export class Structure {
  constructor(private h: StructureHost) {}

  private get app() {
    return this.h.app;
  }

  create(input: NewItem): Promise<Done> {
    return this.h.serial(async () => {
      const n = { ...input, parent: input.parent ? this.h.follow(input.parent) : null, deps: input.deps?.map(d => this.h.follow(d)) };
      const refused = newItemError(this.h.state, n);
      if (refused) return { error: refused };
      const title = safeTitle(n.title);
      if (!title) return { error: 'Give it a name.' };
      let id = '';
      const error = await this.h.atomic(`Added ${title}`, async () => {
        const home = n.kind === 'ext' ? { folder: join(this.h.root, '_external'), id: null } : await this.homeIn(n.parent);
        const name = await this.freeTitle(home.folder, title);
        id = md(home.folder, name);
        const edit = addEdit({ ...n, id, title: name, parent: home.id });
        const trial = structuredClone(this.h.state);
        edit(trial);
        const fm = noteFields(this.app, id, trial.items[id]);
        await this.ensureFolder(home.folder);
        await this.newNote(id, noteText(fm), fm, `Added ${title}`, () => this.h.apply(edit));
      });
      return error ? { error } : { id };
    });
  }

  move(item: string, toParent: string | null, before: string | null = null): Promise<Done> {
    return this.h.serial(async () => {
      let id = this.h.follow(item);
      const parent = toParent ? this.h.follow(toParent) : null;
      const it = this.h.state.items[id];
      if (!it) return { error: 'That item is gone.' };
      const refused = moveError(this.h.state, id, parent);
      if (refused) return { error: refused };
      const label = `Moved ${it.title}`;
      const error = await this.h.atomic(label, async () => {
        let to = parent;
        if (parent !== (it.parent ?? null)) {
          const home = await this.homeIn(parent);
          to = home.id;
          id = await this.place(id, home.folder, await this.freeTitle(home.folder, it.title, id), label);
        }
        this.h.apply(moveEdit(id, to, before ? this.h.follow(before) : null));
      });
      return error ? { error } : { id };
    });
  }

  rename(item: string, title: string): Promise<Done> {
    return this.h.serial(async () => {
      let id = this.h.follow(item);
      const it = this.h.state.items[id];
      const name = safeTitle(title);
      if (!it) return { error: 'That item is gone.' };
      if (!name) return { error: 'Give it a name.' };
      if (name === it.title) return { id };
      const label = `Renamed ${it.title} to ${name}`;
      const error = await this.h.atomic(label, async () => {
        const dir = this.isBox(id) ? dirOf(dirOf(id)) : dirOf(id);
        // A change of case only: the file system may call that a clash with itself.
        const free = name.toLowerCase() === it.title.toLowerCase() ? name : await this.freeTitle(dir, name, id);
        id = await this.place(id, dir, free, label);
      });
      return error ? { error } : { id };
    });
  }

  /** Notes go to Obsidian's trash, which offers no way back, so undo writes them again from memory. */
  remove(item: string): Promise<Done> {
    return this.h.serial(async () => {
      const id = this.h.follow(item);
      const it = this.h.state.items[id];
      if (!it) return { error: 'That item is gone.' };
      const ids = subtree(this.h.state, id);
      const label = ids.length > 1 ? `Deleted ${it.title} and ${ids.length - 1} inside it` : `Deleted ${it.title}`;
      const error = await this.h.atomic(label, async () => {
        await this.h.flushNotes();
        const saved: { path: string; text: string; fm: Patch }[] = [];
        for (const path of ids) {
          const file = this.app.vault.getFileByPath(path);
          if (file) saved.push({ path, text: await this.app.vault.read(file), fm: this.h.frontmatterOf(path) });
        }
        const boxes = ids.filter(i => this.isBox(i)).map(dirOf);
        const trashed: typeof saved = [];
        this.h.apply(removeEdit(id));
        this.h.record({
          label,
          undo: async () => {
            for (const s of trashed) {
              await this.ensureFolder(dirOf(s.path));
              await this.app.vault.create(s.path, s.text);
              this.h.seed(s.path, s.fm);
            }
          },
          moved: (from, to) => {
            for (const s of trashed) s.path = movedPath(s.path, from, to);
          },
        });
        for (const s of saved) {
          this.h.drop(s.path);
          await this.app.fileManager.trashFile(this.app.vault.getFileByPath(s.path)!);
          trashed.push(s);
        }
        for (const box of boxes.reverse()) await this.trashIfEmpty(box);
      });
      return error ? { error } : {};
    });
  }

  /** A new note in Obsidian's folder for new notes, linked to an item. */
  linkNew(item: string, title: string): Promise<Done> {
    return this.h.serial(async () => {
      const id = this.h.follow(item);
      const name = safeTitle(title);
      if (!name) return { error: 'Give it a name.' };
      const label = `Linked ${name}`;
      let path = '';
      const error = await this.h.atomic(label, async () => {
        const dir = this.app.fileManager.getNewFileParent(id).path;
        const folder = dir === '/' ? '' : dir;
        path = md(folder, await this.freeTitle(folder, name));
        await this.newNote(path, '', {}, label, () => this.h.apply(linkNote(id, path)));
      });
      return error ? { error } : { id: path };
    });
  }

  /** A note named for its folder, `<dir>/<title>/<title>.md`, which moves with what is inside it. */
  private isBox(id: string) {
    const dir = dirOf(id);
    return dir !== this.h.root && dir.split('/').pop() === nameOf(id);
  }

  /** The folder children of `parent` live in. An item that gains children moves into a folder of its own. */
  private async homeIn(parent: string | null | undefined): Promise<{ folder: string; id: string | null }> {
    if (!parent) return { folder: this.h.root, id: null };
    if (this.isBox(parent)) return { folder: dirOf(parent), id: parent };
    const dir = dirOf(parent);
    const { exists } = this.app.vault.adapter;
    const base = nameOf(parent);
    let title = base;
    for (let n = 2; await exists.call(this.app.vault.adapter, md(join(dir, title), title)); n++) title = `${base} ${n}`;
    const folder = join(dir, title);
    const made = await this.ensureFolder(folder);
    const id = md(folder, title);
    await this.renamed(parent, id, 'Moved note', made);
    return { folder, id };
  }

  /** Puts a note where it belongs. A folder note takes its folder along. */
  private async place(id: string, dir: string, title: string, label: string): Promise<string> {
    if (!this.isBox(id)) {
      const to = md(dir, title);
      if (to !== id) await this.renamed(id, to, label);
      return to;
    }
    const box = join(dir, title);
    if (box !== dirOf(id)) await this.renamed(dirOf(id), box, label);
    const inner = md(box, nameOf(id));
    const to = md(box, title);
    if (to !== inner) await this.renamed(inner, to, label);
    return to;
  }

  /** Renames through Obsidian, so links follow, and records the way back. */
  private async renamed(from: string, to: string, label: string, folders: string[] = []) {
    const { vault, fileManager } = this.app;
    await fileManager.renameFile(vault.getAbstractFileByPath(from)!, to);
    let back = from;
    let here = to;
    let made = folders;
    this.h.record({
      label,
      undo: async () => {
        const file = vault.getAbstractFileByPath(here);
        if (file) await fileManager.renameFile(file, back);
        for (const f of [...made].reverse()) await this.trashIfEmpty(f);
      },
      moved: (a, b) => {
        back = movedPath(back, a, b);
        here = movedPath(here, a, b);
        made = made.map(f => movedPath(f, a, b));
      },
    });
  }

  /** `then` is the edit that goes with the note: undo takes the note first, as the parent's hours need it gone. */
  private async newNote(path: string, text: string, fm: Patch, label: string, then: () => void) {
    const { vault, fileManager } = this.app;
    await vault.create(path, text);
    if (Object.keys(fm).length) this.h.seed(path, fm);
    then();
    let here = path;
    this.h.record({
      label,
      undo: async () => {
        this.h.drop(here);
        const file = vault.getFileByPath(here);
        if (file) await fileManager.trashFile(file);
      },
      moved: (a, b) => {
        here = movedPath(here, a, b);
      },
    });
  }

  private async trashIfEmpty(path: string) {
    const folder = this.app.vault.getFolderByPath(path);
    if (folder && !folder.children.length) await this.app.fileManager.trashFile(folder);
  }

  /** Creates what is missing, top down. Returns the folders it made. */
  private async ensureFolder(path: string): Promise<string[]> {
    const made: string[] = [];
    let at = '';
    for (const part of path.split('/').filter(Boolean)) {
      at = join(at, part);
      if (this.app.vault.getFolderByPath(at)) continue;
      await this.app.vault.createFolder(at);
      made.push(at);
    }
    return made;
  }

  /** `title`, or the first numbered form neither a note nor a folder holds. `own` does not count as a clash. */
  private async freeTitle(dir: string, title: string, own?: string): Promise<string> {
    const { adapter } = this.app.vault;
    const ownBox = own && this.isBox(own) ? dirOf(own) : undefined;
    const taken = async (t: string) => {
      const file = md(dir, t);
      const box = join(dir, t);
      return (file !== own && (await adapter.exists(file))) || (box !== ownBox && (await adapter.exists(box)));
    };
    let name = title;
    for (let n = 2; await taken(name); n++) name = `${title} ${n}`;
    return name;
  }
}
