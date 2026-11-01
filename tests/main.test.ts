import { describe, expect, it, vi } from 'vitest';
import { FakeObsidian } from './store/fake-obsidian';

vi.mock('obsidian', () => ({
  Plugin: class {
    unloaders: (() => void)[] = [];
    constructor(public app: unknown) {}
    register(cb: () => void) {
      this.unloaders.push(cb);
    }
  },
}));

const { default: TaskmasterPlugin } = await import('../src/main');

const setup = () => {
  const o = new FakeObsidian();
  let ready: () => void = () => {};
  const app = { ...o.app, workspace: { onLayoutReady: (cb: () => void) => (ready = cb) } };
  const plugin = new (TaskmasterPlugin as unknown as new (app: unknown) => InstanceType<typeof TaskmasterPlugin>)(app);
  return { o, plugin, ready: () => ready() };
};

describe('plugin load', () => {
  it('touches nothing during onload', async () => {
    const { o, plugin } = setup();
    o.stateJson = '{}';
    const files = vi.spyOn(o.app.vault, 'getMarkdownFiles');
    await plugin.onload();
    expect(files).not.toHaveBeenCalled();
    expect(o.reads).toEqual([]);
    expect(plugin.store).toBeUndefined();
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
