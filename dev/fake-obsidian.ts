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
  private active: { path: string } | null = null;
  async openLinkText(link: string) {
    this.opened.push(link);
  }
  setActive(path: string | null) {
    this.active = path ? { path } : null;
  }
  getActiveFile() {
    return this.active;
  }
  getActiveViewOfType() {
    return null;
  }
  /** The layout never gets ready: what `onload` defers stays deferred. */
  onLayoutReady(_cb: () => void) {}
}

/** Every Notice shown. */
export const notices: string[] = [];

export class Notice {
  constructor(message: string) {
    notices.push(message);
  }
}

/** Obsidian's modal, as far as a keyboard can tell. */
export class Modal {
  containerEl = document.createElement('div');
  titleEl = document.createElement('h2');
  contentEl = document.createElement('div');
  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    this.close();
  };
  constructor(public app: FakeApp) {
    this.containerEl.className = 'tm-fake-dialog';
    this.containerEl.style.cssText = 'position:fixed;top:120px;left:35%;width:30%;z-index:50;padding:12px 16px;background:var(--background-primary);color:var(--text-normal);border:1px solid var(--background-modifier-border);border-radius:8px';
    this.containerEl.append(this.titleEl, this.contentEl);
  }
  setTitle(title: string) {
    this.titleEl.textContent = title;
    return this;
  }
  onOpen(): void {}
  onClose(): void {}
  open() {
    document.body.append(this.containerEl);
    document.addEventListener('keydown', this.onKey, true);
    this.onOpen();
  }
  close() {
    document.removeEventListener('keydown', this.onKey, true);
    this.containerEl.remove();
    this.onClose();
  }
}

class FakeText {
  inputEl = document.createElement('input');
  getValue() {
    return this.inputEl.value;
  }
  setValue(v: string) {
    this.inputEl.value = v;
    return this;
  }
  setPlaceholder(v: string) {
    this.inputEl.placeholder = v;
    return this;
  }
}

class FakeButton {
  buttonEl = document.createElement('button');
  setButtonText(t: string) {
    this.buttonEl.textContent = t;
    return this;
  }
  setIcon(_: string) {
    this.buttonEl.textContent = '×';
    return this;
  }
  setTooltip(t: string) {
    this.buttonEl.setAttribute('aria-label', t);
    return this;
  }
  onClick(cb: () => void) {
    this.buttonEl.addEventListener('click', cb);
    return this;
  }
}

export class Setting {
  settingEl = document.createElement('div');
  private info = document.createElement('div');
  private control = document.createElement('div');
  constructor(el: HTMLElement) {
    this.settingEl.className = 'setting-item';
    this.settingEl.style.cssText = 'display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-top:1px solid var(--background-modifier-border)';
    this.control.style.cssText = 'display:flex;gap:6px;align-items:center';
    this.settingEl.append(this.info, this.control);
    el.append(this.settingEl);
  }
  setName(name: string) {
    this.info.append(Object.assign(document.createElement('div'), { textContent: name }));
    return this;
  }
  setDesc(desc: string) {
    const d = Object.assign(document.createElement('small'), { textContent: desc });
    d.style.color = 'var(--text-muted)';
    this.info.append(d);
    return this;
  }
  setHeading() {
    this.info.style.fontWeight = '600';
    return this;
  }
  addText(cb: (t: FakeText) => unknown) {
    const t = new FakeText();
    this.control.append(t.inputEl);
    cb(t);
    return this;
  }
  addButton(cb: (b: FakeButton) => unknown) {
    const b = new FakeButton();
    this.control.append(b.buttonEl);
    cb(b);
    return this;
  }
  addExtraButton(cb: (b: FakeButton) => unknown) {
    return this.addButton(cb);
  }
}

type Emptiable = HTMLElement & { empty(): void };

export abstract class PluginSettingTab {
  containerEl = document.createElement('div') as unknown as Emptiable;
  constructor(public app: FakeApp, _plugin: unknown) {
    this.containerEl.empty = () => this.containerEl.replaceChildren();
    this.containerEl.className = 'tm-fake-settings';
    this.containerEl.style.cssText = 'position:fixed;inset:60px 25%;z-index:40;overflow:auto;padding:12px 16px;background:var(--background-primary);color:var(--text-normal);border:1px solid var(--background-modifier-border)';
  }
  abstract display(): void;
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

/** Enough for `onload`, for measuring it. */
export class Plugin {
  constructor(public app: FakeApp, public manifest?: unknown) {}
  registerView(_type: string, _make: unknown) {}
  addCommand(_c: unknown) {}
  addSettingTab(_t: unknown) {}
  register(_cb: () => void) {}
  addStatusBarItem() {
    return document.createElement('div');
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
