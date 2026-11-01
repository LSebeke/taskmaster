import type { State, Todo } from '../src/engine';
import { TaskmasterView } from '../src/view';
import { FakeApp, Scope, WorkspaceLeaf } from './fake-obsidian';
import { bigSeed, seed } from './seed';

const params = new URLSearchParams(location.search);
document.body.classList.add(`theme-${params.get('theme') ?? 'light'}`);

/** Stands in for TaskmasterStore: the view only needs this much of it. */
class FakeStore {
  state: State = params.has('big') ? bigSeed() : params.has('empty') ? { ...seed(), items: {}, plan: {}, tiers: [] } : seed();
  private listeners = new Set<(s: State) => void>();
  subscribe(l: (s: State) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  async readTodos(id: string): Promise<Todo[]> {
    return this.state.items[id]?.todos ?? [];
  }
  emit() {
    for (const l of this.listeners) l(this.state);
  }
}

const app = new FakeApp();
const store = new FakeStore();
const leaf = new WorkspaceLeaf(app);
const view = new TaskmasterView(leaf as never, () => store);
document.body.append(view.containerEl);

const started = performance.now();
void Promise.resolve(view.onOpen()).then(() => {
  // Obsidian's keymap sends keys to the active view's scope.
  document.addEventListener('keydown', e => {
    for (const h of (view.scope as unknown as Scope | null)?.handlers ?? []) if (h.key === e.key) h.func(e, {});
  });
  Object.assign(window, { tm: { app, store, view, openMs: performance.now() - started } });
});
