/** The Obsidian surface the view touches, for the browser harness. Replaces `obsidian` at bundle time. */

type Handler = (evt: KeyboardEvent, ctx: unknown) => false | unknown;

export class Scope {
  handlers: { key: string | null; func: Handler }[] = [];
  constructor(public parent?: Scope) {}
  register(_modifiers: unknown, key: string | null, func: Handler) {
    const h = { key, func };
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
