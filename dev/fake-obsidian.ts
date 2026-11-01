/** The Obsidian surface the view touches, for the browser harness. Replaces `obsidian` at bundle time. */

type Handler = (evt: KeyboardEvent, ctx: unknown) => false | unknown;
type Modifiers = string[] | null;

export class Scope {
  handlers: { modifiers: Modifiers; key: string | null; func: Handler }[] = [];
  constructor(public parent?: Scope) {}
  register(modifiers: Modifiers, key: string | null, func: Handler) {
    const h = { modifiers, key, func };
    this.handlers.push(h);
    return h;
  }
}

class Events {
  private refs: { name: string; cb: () => void }[] = [];
  on(name: string, cb: () => void) {
    const ref = { name, cb };
    this.refs.push(ref);
    return ref;
  }
  trigger(name: string) {
    for (const r of this.refs) if (r.name === name) r.cb();
  }
}

export class FakeWorkspace extends Events {
  opened: string[] = [];
  async openLinkText(link: string) {
    this.opened.push(link);
  }
}

export class FakeApp {
  scope = new Scope();
  workspace = new FakeWorkspace();
  /** The harness puts the fake vault's here. */
  vault!: { getMarkdownFiles(): { path: string }[] };
}

type Match<T> = { item: T; match: { score: number; matches: number[][] } };

/** Obsidian's fuzzy picker, as far as a keyboard can tell: a field, a list, Enter, Esc. */
export abstract class FuzzySuggestModal<T> {
  private el: HTMLElement | null = null;
  constructor(public app: FakeApp) {}
  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T, evt: Event): void;
  setPlaceholder(_text: string) {}

  getSuggestions(query: string): Match<T>[] {
    const q = query.toLowerCase();
    const fuzzy = (text: string) => {
      let at = 0;
      for (const ch of text.toLowerCase()) if (ch === q[at]) at++;
      return at === q.length;
    };
    const near = (i: T) => (this.getItemText(i).toLowerCase().includes(q) ? 0 : 1);
    return this.getItems()
      .filter(i => fuzzy(this.getItemText(i)))
      .sort((a, b) => near(a) - near(b))
      .map(item => ({ item, match: { score: 0, matches: [] } }));
  }

  open() {
    const el = document.createElement('div');
    el.className = 'tm-fake-modal';
    el.style.cssText = 'position:fixed;top:80px;left:30%;width:40%;z-index:50;padding:8px;background:var(--background-primary);border:1px solid var(--background-modifier-border)';
    const input = el.appendChild(document.createElement('input'));
    const list = el.appendChild(document.createElement('div'));
    const show = () => {
      list.replaceChildren();
      for (const s of this.getSuggestions(input.value).slice(0, 8)) list.appendChild(document.createElement('div')).textContent = this.getItemText(s.item);
    };
    input.addEventListener('input', show);
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
      if (e.key !== 'Enter') return;
      const [first] = this.getSuggestions(input.value);
      this.close();
      if (first) this.onChooseItem(first.item, e);
    });
    document.body.append(el);
    this.el = el;
    show();
    input.focus();
  }

  close() {
    this.el?.remove();
  }
}

export class WorkspaceLeaf {
  constructor(public app: FakeApp) {}
}

export class ItemView {
  app: FakeApp;
  containerEl = document.createElement('div');
  contentEl = document.createElement('div');
  scope: Scope | null = null;
  private cleanup: (() => void)[] = [];

  constructor(public leaf: WorkspaceLeaf) {
    this.app = leaf.app;
    this.containerEl.className = 'workspace-leaf-content';
    this.contentEl.className = 'view-content';
    this.containerEl.append(this.contentEl);
  }
  registerEvent(_ref: unknown) {}
  register(cb: () => void) {
    this.cleanup.push(cb);
  }
}
