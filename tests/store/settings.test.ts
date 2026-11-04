import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyze, dayOf as D } from '../../src/engine';
import { addHoliday, removeHoliday, setStaleDays, TaskmasterStore } from '../../src/store';
import { FakeObsidian } from './fake-obsidian';

const task = (left = 12, extra = {}) => ({ 'tm-type': 'item', 'tm-estimate': left, 'tm-left': left, ...extra });

let o: FakeObsidian;
let store: TaskmasterStore;

const boot = async (opts = {}) => {
  store = new TaskmasterStore(o.app, { today: () => D('2026-11-02'), debounceMs: 100, writeMs: 300, ...opts });
  await store.load();
  await vi.advanceTimersByTimeAsync(0);
};
const settle = async () => {
  await vi.advanceTimersByTimeAsync(300);
  o.deliver();
  await vi.advanceTimersByTimeAsync(100);
  await store.flush();
};
const stateFile = () => JSON.parse(o.stateJson!);
const ids = () => Object.keys(store.state.items);

beforeEach(() => {
  vi.useFakeTimers();
  o = new FakeObsidian();
  o.folders.add('Projects');
  o.folders.add('Work');
  o.add('Projects/a.md', task());
  o.add('Work/b.md', task());
});

afterEach(() => {
  store.dispose();
  vi.useRealTimers();
});

describe('stale days', () => {
  it('moves the flag at once, persists, undoes', async () => {
    o.add('Projects/s.md', task(6, { 'tm-started': '2026-10-20', 'tm-left-updated': '2026-10-30' }));
    await boot();
    const stale = () => analyze(store.state).results['Projects/s.md'].stale;
    expect(stale()).toBeUndefined();
    store.apply(setStaleDays(3));
    expect(stale()).toBe(3);
    await settle();
    expect(stateFile().staleDays).toBe(3);
    await store.undo();
    expect(store.state.settings.staleDays).toBe(7);
    await settle();
    store.dispose();
    await boot();
    expect(store.state.settings.staleDays).toBe(7);
  });

  it('holds through a reload', async () => {
    await boot();
    store.apply(setStaleDays(14));
    await settle();
    store.dispose();
    await boot();
    expect(store.state.settings.staleDays).toBe(14);
  });

  it('must be a whole number of days of at least 1', async () => {
    await boot();
    for (const n of [0, -2, 1.5, Number.NaN]) expect(store.apply(setStaleDays(n))).toBe(false);
  });

  it('a bad value in state.json is skipped and reported', async () => {
    o.stateJson = JSON.stringify({ staleDays: 'soon' });
    await boot();
    expect(store.state.settings.staleDays).toBe(7);
    expect(store.warnings).toEqual([expect.objectContaining({ field: 'staleDays' })]);
  });
});

describe('holidays', () => {
  it('a holiday takes the day out of the forecast, persists, and undo restores it', async () => {
    await boot();
    // 12h at 6h/day: 2 and 3 Nov. With 3 Nov off, 2 and 4 Nov.
    const end = () => analyze(store.state).results['Projects/a.md'].end;
    expect(end()).toBe(D('2026-11-03'));
    store.apply(addHoliday(D('2026-11-03')));
    expect(end()).toBe(D('2026-11-04'));
    await settle();
    expect(stateFile().holidays).toEqual(['2026-11-03']);
    await store.undo();
    expect(end()).toBe(D('2026-11-03'));
  });

  it('stay sorted, without duplicates', async () => {
    await boot();
    store.apply(addHoliday(D('2026-12-25')));
    store.apply(addHoliday(D('2026-12-24')));
    expect(store.apply(addHoliday(D('2026-12-25')))).toBe(false);
    expect(store.state.settings.holidays).toEqual([D('2026-12-24'), D('2026-12-25')]);
  });

  it('can be removed', async () => {
    await boot();
    store.apply(addHoliday(D('2026-12-25')));
    expect(store.apply(removeHoliday(D('2026-12-26')))).toBe(false);
    store.apply(removeHoliday(D('2026-12-25')));
    expect(store.state.settings.holidays).toEqual([]);
  });
});

describe('projects folder', () => {
  it('defaults to Projects/', async () => {
    await boot();
    expect(store.projectsFolder).toBe('Projects/');
    expect(ids()).toEqual(['Projects/a.md']);
  });

  it('reads items from the new folder at once, and persists', async () => {
    await boot();
    expect(store.setProjectsFolder('Work')).toBeNull();
    expect(store.projectsFolder).toBe('Work/');
    expect(ids()).toEqual(['Work/b.md']);
    await settle();
    store.dispose();
    await boot();
    expect(ids()).toEqual(['Work/b.md']);
  });

  it('new items and external items land under it', async () => {
    await boot();
    store.setProjectsFolder('Work/');
    expect((await store.create({ kind: 'item', title: 'n' })).id).toBe('Work/n.md');
    expect((await store.create({ kind: 'ext', title: 'x', pinS: D('2026-11-02'), pinE: D('2026-11-03') })).id).toBe('Work/_external/x.md');
  });

  it('follows cache events for the new folder', async () => {
    await boot();
    store.setProjectsFolder('Work');
    o.change('Work/c.md', task());
    await vi.advanceTimersByTimeAsync(100);
    expect(ids()).toContain('Work/c.md');
  });

  it('refuses a folder that does not exist', async () => {
    await boot();
    expect(store.setProjectsFolder('Nowhere')).toMatch(/Nowhere/);
    expect(store.projectsFolder).toBe('Projects/');
  });

  it('undo goes back, priorities included', async () => {
    await boot();
    const tiers = store.state.tiers;
    store.setProjectsFolder('Work');
    await store.undo();
    expect(store.projectsFolder).toBe('Projects/');
    expect(ids()).toEqual(['Projects/a.md']);
    expect(store.state.tiers).toEqual(tiers);
  });
});
