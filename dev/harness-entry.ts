import { analyze } from '../src/engine';
import * as edits from '../src/store/edits';
import { STATE_PATH, TaskmasterStore } from '../src/store';
import { TaskmasterView } from '../src/view';
import { commands, TaskmasterSettingTab } from '../src/view';
import { FakeApp, notices, Scope, WorkspaceLeaf } from './fake-obsidian';
import { perfSeed } from './perf-seed';
import { bigSeed, miniSeed, seed } from './seed';
import { vaultFrom } from './vault';

const params = new URLSearchParams(location.search);
document.body.classList.add(`theme-${params.get('theme') ?? 'light'}`);

const perf = params.get('perf');
const seeded = perf ? perfSeed(JSON.parse(perf)) : params.has('big') ? bigSeed() : params.has('mini') ? miniSeed() : params.has('empty') ? { ...seed(), items: {}, plan: {}, tiers: [] } : seed();
const { vault, pathOf } = vaultFrom(seeded);
vault.echoMs = 15;
if (!perf && !params.has('mini') && !params.has('empty') && !params.has('big')) vault.add('Notes/Bench report.md', undefined, undefined, 'See [[CAN stack port]].');

// As when Obsidian restores a view: it can open before the plugin's stylesheet applies.
const sheet = document.querySelector<HTMLLinkElement>('link[rel=stylesheet]')!;
if (params.has('lateCss')) sheet.disabled = true;

const app = new FakeApp();
app.vault = vault.app.vault;
let skew = 0;
const store = new TaskmasterStore(vault.app, { today: () => seeded.today, now: () => Date.now() + skew, debounceMs: 15, writeMs: 25 });
const leaf = new WorkspaceLeaf(app);
const view = new TaskmasterView(leaf as never, () => store);
document.body.append(view.containerEl);
const host = { app: app as never, store: () => store, view: async () => view };
const list = commands(host);
const settings = new TaskmasterSettingTab(app as never, {} as never, () => store);

/** After the frame that follows: what is on screen by then, layout and paint included. */
const painted = () => new Promise<void>(done => requestAnimationFrame(() => {
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => done();
  port2.postMessage(0);
}));

let started = 0;
const loading = performance.now();
void store.load().then(async () => {
  const loadMs = performance.now() - loading;
  // A view opens in a window that is already drawing. A page's own first frame comes when the browser pleases.
  if (perf) {
    await painted();
    await painted();
  }
  started = performance.now();
  await view.onOpen();
  const openMs = performance.now() - started;
  await painted();
  const paintMs = performance.now() - started;
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
      loadMs,
      openMs,
      /** Budget: store ready to the view on screen. */
      paintMs,
      /** Times `analyze` on seed options, off the page's own state. */
      recalc: (options: Parameters<typeof perfSeed>[0], warm: number, samples: number) => {
        const st = perfSeed(options);
        for (let i = 0; i < warm; i++) analyze(st);
        return Array.from({ length: samples }, () => {
          const t = performance.now();
          analyze(st);
          return performance.now() - t;
        });
      },
      /** Seed ids are stable names for the harness. Items are keyed by note path. */
      path: pathOf,
      note: (id: string) => vault.frontmatter(pathOf(id)),
      forecast: () => JSON.stringify(analyze(store.state).by),
      stateFile: () => JSON.parse(vault.files.get(STATE_PATH) ?? '{}'),
      commands: list,
      command: (id: string) => list.find(c => c.id === id)!.run(),
      notices,
      showStyles: () => void (sheet.disabled = false),
      /** Moves the store's clock on. */
      skew: (ms: number) => (skew += ms),
      openSettings: () => {
        document.body.append(settings.containerEl);
        settings.display();
      },
      closeSettings: () => settings.containerEl.remove(),
    },
  });
});
