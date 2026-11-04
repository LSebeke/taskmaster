import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayOf as D } from '../../src/engine';
import { setTotal, TaskmasterStore, updatePlan } from '../../src/store';
import { FakeObsidian } from './fake-obsidian';

const p = (name: string) => `Projects/${name}.md`;
const NOV2 = D('2026-11-02');

let o: FakeObsidian;
let store: TaskmasterStore;

const boot = async (state: object = {}) => {
  o.stateJson = JSON.stringify(state);
  store = new TaskmasterStore(o.app, { today: () => NOV2, debounceMs: 100, writeMs: 300 });
  await store.load();
  await vi.advanceTimersByTimeAsync(0);
};
const written = async () => {
  await vi.advanceTimersByTimeAsync(300);
  return JSON.parse(o.stateJson!);
};

beforeEach(() => {
  vi.useFakeTimers();
  o = new FakeObsidian();
  // p > g > { a 12h, b 12h }, draft d, external x.
  o.add(p('p'), { 'tm-type': 'item' });
  o.add(p('g'), { 'tm-type': 'item', 'tm-parent': '[[p]]' });
  o.add(p('a'), { 'tm-type': 'item', 'tm-parent': '[[g]]', 'tm-left': 12 });
  o.add(p('b'), { 'tm-type': 'item', 'tm-parent': '[[g]]', 'tm-left': 12 });
  o.add(p('d'), { 'tm-type': 'item' });
  o.add(p('_external/x'), { 'tm-type': 'external', 'tm-pin-start': '2026-12-01', 'tm-pin-end': '2026-12-04' });
});

afterEach(() => {
  store.dispose();
  vi.useRealTimers();
});

describe('Update plan as an edit', () => {
  it('snapshots the forecast deep and says how many items', async () => {
    await boot({ tiers: [[p('a'), p('b')]], capacity: 30 });
    expect(store.apply(updatePlan([p('p')], true))).toBe(true);
    expect(Object.keys(store.state.plan).sort()).toEqual([p('a'), p('b'), p('g'), p('p')].sort());
    expect(store.state.plan[p('a')]).toEqual({ start: NOV2, end: D('2026-11-05'), hours: 12 });
    expect(store.undoLabel).toBe('Plan updated on 4 items');
  });

  it('with sub-levels off, stops at the rows', async () => {
    await boot({ tiers: [[p('a'), p('b')]], capacity: 30 });
    store.apply(updatePlan([p('g')], false));
    expect(Object.keys(store.state.plan)).toEqual([p('g')]);
  });

  it('never touches anything above the target', async () => {
    const old = { start: '2026-10-01', end: '2026-10-02', hours: 1 };
    await boot({ tiers: [[p('a'), p('b')]], capacity: 30, plan: { [p('p')]: old, [p('g')]: old } });
    store.apply(updatePlan([p('a')], true));
    const file = await written();
    expect(file.plan[p('p')]).toEqual(old);
    expect(file.plan[p('g')]).toEqual(old);
    expect(file.plan[p('a')].end).toBe('2026-11-05');
  });

  it('ignores external items, even when asked', async () => {
    await boot({ tiers: [[p('a'), p('b')]], capacity: 30 });
    expect(store.apply(updatePlan([p('_external/x')], true))).toBe(false);
    store.apply(updatePlan([p('_external/x'), p('a')], true));
    expect(Object.keys(store.state.plan)).toEqual([p('a')]);
    expect(store.state.planHistory!.flatMap(h => h.ids)).toEqual([p('a')]);
  });

  it('leaves drafts out: they have no dates to freeze', async () => {
    await boot({ tiers: [[p('a'), p('b')]], capacity: 30 });
    expect(store.apply(updatePlan([p('d')], true))).toBe(false);
    expect(store.state.plan[p('d')]).toBeUndefined();
    expect(store.state.planHistory).toEqual([]);
  });

  it('ignores rows that are gone', async () => {
    await boot({ tiers: [[p('a'), p('b')]], capacity: 30 });
    expect(store.apply(updatePlan([p('nope')], true))).toBe(false);
  });

  it('appends history with the prior values, and persists it', async () => {
    await boot({ tiers: [[p('a'), p('b')]], capacity: 30 });
    store.apply(updatePlan([p('a')], true));
    const first = store.state.plan[p('a')];
    store.apply(setTotal(p('a'), 30));
    store.apply(updatePlan([p('a')], true));
    expect(store.state.planHistory).toEqual([
      { day: NOV2, ids: [p('a')], before: { [p('a')]: undefined } },
      { day: NOV2, ids: [p('a')], before: { [p('a')]: first } },
    ]);
    expect((await written()).planHistory[1].before[p('a')].end).toBe('2026-11-05');
  });

  it('undoes as one step, history included, and the forecast never moves', async () => {
    await boot({ tiers: [[p('a'), p('b')]], capacity: 30 });
    const end = () => store.state.items[p('a')].left;
    const before = end();
    store.apply(updatePlan([p('p')], true));
    expect(end()).toBe(before);
    await store.undo();
    expect(store.state.plan).toEqual({});
    expect(store.state.planHistory).toEqual([]);
    const file = await written();
    expect(file.plan).toEqual({});
    expect(file.planHistory).toEqual([]);
  });
});
