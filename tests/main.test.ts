import { describe, expect, it, vi } from 'vitest';
import { FakeObsidian } from './store/fake-obsidian';

vi.mock('obsidian', () => ({
  ItemView: class {},
  Scope: class {},
  Plugin: class {
    unloaders: (() => void)[] = [];
    views: string[] = [];
    commands: { id: string; callback(): void }[] = [];
    constructor(public app: unknown) {}
    register(cb: () => void) {
      this.unloaders.push(cb);
    }
    registerView(type: string) {
      this.views.push(type);
    }
    addCommand(c: { id: string; callback(): void }) {
      this.commands.push(c);
    }
  },
}));

const { default: TaskmasterPlugin } = await import('../src/main');

const setup = () => {
  const o = new FakeObsidian();
  let isReady = false;
  const waiting: (() => void)[] = [];
  const leaf = { setViewState: vi.fn(async () => {}) };
  const open = { getLeavesOfType: vi.fn((): unknown[] => []), getLeaf: vi.fn(() => leaf), revealLeaf: vi.fn(async () => {}) };
  const onLayoutReady = (cb: () => void) => (isReady ? cb() : waiting.push(cb));
  const ready = () => {
    isReady = true;
    waiting.splice(0).forEach(cb => cb());
  };
  const app = { ...o.app, workspace: { ...open, onLayoutReady } };
  const plugin = new (TaskmasterPlugin as unknown as new (app: unknown) => InstanceType<typeof TaskmasterPlugin>)(app);
  return { o, plugin, leaf, open, ready };
};

describe('plugin load', () => {
  it('does not read the vault for a view restored before the layout is ready', async () => {
    const { o, plugin, ready } = setup();
    o.add('Projects/a.md', { 'tm-type': 'item' });
    await plugin.onload();
    const files = vi.spyOn(o.app.vault, 'getMarkdownFiles');
    (plugin as unknown as { ensureStore(): unknown }).ensureStore();
    await new Promise(r => setTimeout(r));
    expect(files).not.toHaveBeenCalled();
    ready();
    await vi.waitFor(() => expect(plugin.store?.state.items['Projects/a.md']).toBeDefined());
  });

  it('touches nothing during onload', async () => {
    const { o, plugin } = setup();
    o.stateJson = '{}';
    const files = vi.spyOn(o.app.vault, 'getMarkdownFiles');
    await plugin.onload();
    expect(files).not.toHaveBeenCalled();
    expect(o.reads).toEqual([]);
    expect(plugin.store).toBeUndefined();
  });

  it('registers the view and an open command during onload', async () => {
    const { plugin } = setup();
    await plugin.onload();
    const p = plugin as unknown as { views: string[]; commands: { id: string }[] };
    expect(p.views).toEqual(['taskmaster']);
    expect(p.commands.map(c => c.id)).toEqual(['open']);
  });

  it('opens one tab, and reuses it afterwards', async () => {
    const { plugin, leaf, open } = setup();
    await plugin.onload();
    const run = (plugin as unknown as { commands: { callback(): void }[] }).commands[0].callback;
    run();
    await vi.waitFor(() => expect(open.revealLeaf).toHaveBeenCalledWith(leaf));
    expect(leaf.setViewState).toHaveBeenCalledWith({ type: 'taskmaster', active: true });
    expect(open.getLeaf).toHaveBeenCalledTimes(1);
    open.getLeavesOfType.mockReturnValue([leaf]);
    run();
    await vi.waitFor(() => expect(open.revealLeaf).toHaveBeenCalledTimes(2));
    expect(open.getLeaf).toHaveBeenCalledTimes(1);
  });

  it('loads the store once the layout is ready, and stops it on unload', async () => {
    const { o, plugin, ready } = setup();
    o.add('Projects/a.md', { 'tm-type': 'item' });
    await plugin.onload();
    ready();
    await vi.waitFor(() => expect(plugin.store?.state.items['Projects/a.md']).toBeDefined());
    expect(o.listenerCount).toBeGreaterThan(0);
    (plugin as unknown as { unloaders: (() => void)[] }).unloaders.forEach(u => u());
    expect(o.listenerCount).toBe(0);
  });
});
