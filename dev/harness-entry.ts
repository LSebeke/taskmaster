import { analyze } from '../src/engine';
import * as edits from '../src/store/edits';
import { STATE_PATH, TaskmasterStore } from '../src/store';
import { TaskmasterView } from '../src/view';
import { FakeApp, Scope, WorkspaceLeaf } from './fake-obsidian';
import { bigSeed, seed } from './seed';
import { vaultFrom } from './vault';

const params = new URLSearchParams(location.search);
document.body.classList.add(`theme-${params.get('theme') ?? 'light'}`);

const seeded = params.has('big') ? bigSeed() : params.has('empty') ? { ...seed(), items: {}, plan: {}, tiers: [] } : seed();
const { vault, pathOf } = vaultFrom(seeded);
vault.echoMs = 15;

const app = new FakeApp();
const store = new TaskmasterStore(vault.app, { today: () => seeded.today, debounceMs: 15, writeMs: 25 });
const leaf = new WorkspaceLeaf(app);
const view = new TaskmasterView(leaf as never, () => store);
document.body.append(view.containerEl);

let started = 0;
void store.load().then(async () => {
  started = performance.now();
  await view.onOpen();
  // Obsidian's keymap sends keys to the active view's scope.
  document.addEventListener('keydown', e => {
    for (const h of (view.scope as unknown as Scope | null)?.handlers ?? []) {
      if (h.key !== e.key || !!h.modifiers?.includes('Mod') !== e.ctrlKey) continue;
      if (h.func(e, {}) === false) e.preventDefault();
    }
  });
  Object.assign(window, {
    tm: {
      app,
      store,
      view,
      vault,
      edits,
      analyze: () => analyze(store.state),
      openMs: performance.now() - started,
      /** Seed ids are stable names for the harness. Items are keyed by note path. */
      path: pathOf,
      note: (id: string) => vault.frontmatter(pathOf(id)),
      stateFile: () => JSON.parse(vault.files.get(STATE_PATH) ?? '{}'),
    },
  });
});
