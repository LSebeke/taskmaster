import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayOf as D, type State } from '../../src/engine';
import { TaskmasterStore } from '../../src/store';
import { FakeObsidian } from './fake-obsidian';

const DEBOUNCE = 100;
const p = (name: string) => `Projects/${name}.md`;
const item = (left = 6, extra = {}) => ({ 'tm-type': 'item', 'tm-left': left, ...extra });

let o: FakeObsidian;
let today: number;
let store: TaskmasterStore;
let events: State[];

const boot = async () => {
  store = new TaskmasterStore(o.app, { today: () => today, debounceMs: DEBOUNCE });
  await store.load();
  await vi.advanceTimersByTimeAsync(0); // Dates are recorded just after boot.
  events = [];
  store.subscribe(s => events.push(s));
};

const settle = () => vi.advanceTimersByTime(DEBOUNCE);

beforeEach(() => {
  vi.useFakeTimers();
  o = new FakeObsidian();
  today = D('2026-11-02');
});

afterEach(() => {
  store.dispose();
  vi.useRealTimers();
});

describe('recompute events', () => {
  it('fires once on load for listeners already subscribed', async () => {
    o.add(p('a'), item());
    store = new TaskmasterStore(o.app, { today: () => today });
    const seen = vi.fn();
    store.subscribe(seen);
    await store.load();
    expect(seen).toHaveBeenCalledOnce();
    expect(seen).toHaveBeenCalledWith(store.state, undefined);
  });

  it('picks up a cache change after the debounce, not before', async () => {
    o.add(p('a'), item(6));
    await boot();
    o.change(p('a'), item(9));
    expect(store.state.items[p('a')].left).toBe(6);
    settle();
    expect(store.state.items[p('a')].left).toBe(9);
    expect(events).toHaveLength(1);
  });

  it('coalesces a burst across notes into one recompute', async () => {
    o.add(p('a'), item(1));
    o.add(p('b'), item(1));
    await boot();
    o.change(p('a'), item(2));
    vi.advanceTimersByTime(DEBOUNCE / 2);
    o.change(p('b'), item(3));
    o.change(p('a'), item(4));
    o.remove(p('b'));
    settle();
    expect(events).toHaveLength(1);
    expect(store.state.items).toMatchObject({ [p('a')]: { left: 4 } });
    expect(store.state.items[p('b')]).toBeUndefined();
  });

  it('cannot be starved by a steady stream of changes', async () => {
    o.add(p('a'), item(1));
    await boot();
    for (let i = 2; i < 12; i++) {
      o.change(p('a'), item(i));
      vi.advanceTimersByTime(DEBOUNCE / 3);
    }
    expect(events.length).toBeGreaterThan(0);
  });

  it('stays silent when a change leaves the projection as it was', async () => {
    o.add(p('a'), item());
    await boot();
    o.change(p('a'), item(), undefined, 'new body text');
    settle();
    expect(events).toEqual([]);
  });

  it('ignores notes outside the projects folder', async () => {
    o.add(p('a'), item());
    await boot();
    const spy = vi.spyOn(o.app.vault, 'getMarkdownFiles');
    o.change('Daily/today.md', { 'tm-type': 'item' });
    settle();
    expect(spy).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('surfaces a new warning even if no item changed', async () => {
    o.add(p('a'), item());
    await boot();
    o.change(p('a'), item(6, { 'tm-scope': 'whenever' }));
    settle();
    expect(events).toHaveLength(1);
    expect(store.warnings).toContainEqual(expect.objectContaining({ field: 'tm-scope' }));
    o.change(p('a'), item());
    settle();
    expect(store.warnings).toEqual([]);
  });

  it('takes the date afresh on each recompute', async () => {
    o.add(p('a'), item());
    await boot();
    today += 1;
    o.change(p('a'), item(5));
    settle();
    expect(store.state.today).toBe(D('2026-11-03'));
  });

  it('unsubscribes', async () => {
    o.add(p('a'), item(1));
    store = new TaskmasterStore(o.app, { debounceMs: DEBOUNCE });
    await store.load();
    const seen = vi.fn();
    store.subscribe(seen)();
    o.change(p('a'), item(2));
    settle();
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('delete', () => {
  it('takes the item out of the items and levels, and dependents survive', async () => {
    o.add(p('a'), item());
    o.add(p('b'), item(6, { 'tm-deps': ['[[a]]'] }));
    await boot();
    o.remove(p('a'));
    settle();
    expect(store.state.items[p('a')]).toBeUndefined();
    expect(store.state.tiers.flat()).toEqual([p('b')]);
    expect(store.state.items[p('b')].deps).toEqual([]);
    expect(store.warnings).toContainEqual(expect.objectContaining({ path: p('b'), field: 'tm-deps' }));
  });
});

describe('rename', () => {
  const plan = { start: '2026-11-02', end: '2026-11-03', hours: 6 };

  it('moves the item, its level, plan entry and history in memory, and writes nothing', async () => {
    o.add(p('a'), item());
    o.add(p('z'), item());
    o.stateJson = JSON.stringify({
      tiers: [[p('z')], [p('a')]],
      plan: { [p('a')]: plan },
      planHistory: [{ day: '2026-10-01', ids: [p('a')], before: { [p('a')]: plan } }],
    });
    await boot();
    const entry = store.state.plan[p('a')];
    o.rename(p('a'), p('b'));
    settle();

    expect(store.state.items[p('a')]).toBeUndefined();
    expect(store.state.items[p('b')].title).toBe('b');
    expect(store.state.tiers).toEqual([[p('z')], [p('b')]]);
    expect(store.state.plan).toEqual({ [p('b')]: entry });
    expect(store.state.planHistory).toEqual([{ day: D('2026-10-01'), ids: [p('b')], before: { [p('b')]: entry } }]);
    expect(events).toHaveLength(1);
  });

  it('follows two renames inside one debounce window', async () => {
    o.add(p('a'), item());
    o.stateJson = JSON.stringify({ plan: { [p('a')]: plan } });
    await boot();
    o.rename(p('a'), p('b'));
    o.rename(p('b'), p('c'));
    settle();
    expect(Object.keys(store.state.plan)).toEqual([p('c')]);
    expect(store.state.tiers).toEqual([[p('c')]]);
  });

  it('rewrites every note under a renamed folder', async () => {
    o.add('Projects/Old/a.md', item());
    o.add('Projects/Old/sub/b.md', item());
    o.add('Projects/Older/c.md', item());
    o.stateJson = JSON.stringify({
      tiers: [['Projects/Old/sub/b.md'], ['Projects/Old/a.md'], ['Projects/Older/c.md']],
      plan: { 'Projects/Old/a.md': plan },
    });
    await boot();
    o.renameFolder('Projects/Old', 'Projects/New');
    settle();
    expect(store.state.tiers).toEqual([['Projects/New/sub/b.md'], ['Projects/New/a.md'], ['Projects/Older/c.md']]);
    expect(Object.keys(store.state.plan)).toEqual(['Projects/New/a.md']);
  });

  it('settles on one event when Obsidian then updates links to the note', async () => {
    o.add(p('parent'), item(0));
    o.add(p('child'), item(6, { 'tm-parent': '[[parent]]' }));
    await boot();
    o.rename(p('parent'), p('renamed'));
    o.change(p('child'), item(6, { 'tm-parent': '[[renamed]]' }));
    settle();
    expect(store.state.items[p('child')].parent).toBe(p('renamed'));
    expect(store.warnings).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it('refreshes tm-notes when a linked note outside the folder is renamed', async () => {
    o.add('Elsewhere/call.md');
    o.add(p('a'), item(6, { 'tm-notes': ['[[Elsewhere/call]]'] }));
    await boot();
    o.rename('Elsewhere/call.md', 'Elsewhere/meeting.md');
    o.change(p('a'), item(6, { 'tm-notes': ['[[Elsewhere/meeting]]'] }));
    settle();
    expect(store.state.items[p('a')].notes).toEqual(['Elsewhere/meeting.md']);
  });
});

describe('indexing after boot', () => {
  it('slots a late note into its saved level', async () => {
    o.add(p('a'), item());
    o.addUnindexed(p('b'));
    o.stateJson = JSON.stringify({ tiers: [[p('b')], [p('a')]] });
    await boot();
    o.change(p('b'), item());
    settle();
    expect(store.state.items[p('b')].left).toBe(6);
    expect(store.state.tiers).toEqual([[p('b')], [p('a')]]);
  });
});

describe('dispose', () => {
  it('drops listeners and any pending recompute', async () => {
    o.add(p('a'), item(1));
    await boot();
    expect(o.listenerCount).toBeGreaterThan(0);
    o.change(p('a'), item(2));
    store.dispose();
    settle();
    expect(o.listenerCount).toBe(0);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('wins a race with load', async () => {
    store = new TaskmasterStore(o.app);
    const loading = store.load();
    store.dispose();
    await loading;
    expect(o.listenerCount).toBe(0);
  });
});
