import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyze, dayOf as D } from '../../src/engine';
import { addLevel, moveTask, removeLevel, STATE_PATH, TaskmasterStore } from '../../src/store';
import { FakeObsidian } from './fake-obsidian';

const p = (name: string) => `Projects/${name}.md`;
const [A, B, C, E] = ['a', 'b', 'c', 'e'].map(p);
const WRITE = 300;

let o: FakeObsidian;
let store: TaskmasterStore;

const boot = async (tiers: string[][] = [[A, B], [C]]) => {
  for (const [path, left] of [
    [A, 40],
    [B, 12],
    [C, 30],
    [E, 25],
  ] as const)
    o.add(path, { 'tm-type': 'item', 'tm-left': left });
  o.stateJson = JSON.stringify({ tiers: [...tiers.slice(0, -1), [...tiers.at(-1)!, E]] });
  store = new TaskmasterStore(o.app, { today: () => D('2026-11-02'), debounceMs: 100, writeMs: WRITE });
  await store.load();
  await vi.advanceTimersByTimeAsync(0);
};
const saved = () => JSON.parse(o.files.get(STATE_PATH)!).tiers;
const forecast = () => {
  const { by } = analyze(store.state);
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, [v.start, v.end, v.burn]]));
};

beforeEach(() => {
  vi.useFakeTimers();
  o = new FakeObsidian();
});

afterEach(() => {
  store.dispose();
  vi.useRealTimers();
});

describe('moving a task between levels', () => {
  it('changes who gets hours, writes state.json and undoes', async () => {
    await boot();
    const before = forecast();
    store.apply(moveTask(C, 0));
    expect(store.state.tiers).toEqual([[A, B, C], [E]]);
    expect(store.undoLabel).toBe('Moved c to Priority 1');
    expect(forecast()).not.toEqual(before);
    await vi.advanceTimersByTimeAsync(WRITE);
    expect(saved()).toEqual([[A, B, C], [E]]);
    await store.undo();
    expect(store.state.tiers).toEqual([[A, B], [C, E]]);
    expect(forecast()).toEqual(before);
  });

  it('goes before the task it was dropped on', async () => {
    await boot();
    store.apply(moveTask(C, 0, B));
    expect(store.state.tiers[0]).toEqual([A, C, B]);
  });

  it('keeps a level its last task left', async () => {
    await boot([[A], [B, C]]);
    store.apply(moveTask(A, 1));
    expect(store.state.tiers).toEqual([[], [B, C, E, A]]);
  });
});

describe('reordering inside a level', () => {
  it('never changes the forecast, and is undoable', async () => {
    await boot();
    const before = forecast();
    store.apply(moveTask(B, 0, A));
    expect(store.state.tiers[0]).toEqual([B, A]);
    expect(store.undoLabel).toBe('Reordered b');
    expect(forecast()).toEqual(before);
    await vi.advanceTimersByTimeAsync(WRITE);
    expect(saved()[0]).toEqual([B, A]);
    await store.undo();
    expect(store.state.tiers[0]).toEqual([A, B]);
  });

  it('dropped where it was is no edit', async () => {
    await boot();
    expect(store.apply(moveTask(A, 0, B))).toBe(false);
    expect(store.undoLabel).toBeNull();
  });
});

describe('a move that no longer applies', () => {
  it('does nothing for a level or task that is gone', async () => {
    await boot();
    expect(store.apply(moveTask(A, 5))).toBe(false);
    expect(store.apply(moveTask(p('gone'), 0))).toBe(false);
  });
});

describe('levels', () => {
  it('are added above any level, and at the bottom', async () => {
    await boot();
    store.apply(addLevel(1));
    expect(store.state.tiers).toEqual([[A, B], [], [C, E]]);
    store.apply(addLevel(3));
    expect(store.state.tiers).toEqual([[A, B], [], [C, E], []]);
    await vi.advanceTimersByTimeAsync(WRITE);
    expect(saved()).toEqual([[A, B], [], [C, E], []]);
  });

  it('do not change the forecast when added or removed empty', async () => {
    await boot();
    const before = forecast();
    store.apply(addLevel(0));
    expect(forecast()).toEqual(before);
    store.apply(removeLevel(0));
    expect(store.state.tiers).toEqual([[A, B], [C, E]]);
    expect(forecast()).toEqual(before);
    await store.undo();
    expect(store.state.tiers).toEqual([[], [A, B], [C, E]]);
  });

  it('are refused removal unless empty', async () => {
    await boot();
    expect(store.apply(removeLevel(0))).toBe(false);
    expect(store.apply(removeLevel(9))).toBe(false);
    expect(store.state.tiers).toEqual([[A, B], [C, E]]);
  });

  it('new tasks join the last level, even an empty one', async () => {
    await boot();
    store.apply(addLevel(2));
    o.change(p('n'), { 'tm-type': 'item', 'tm-left': 5 });
    await vi.advanceTimersByTimeAsync(100);
    expect(store.state.tiers).toEqual([[A, B], [C, E], [p('n')]]);
  });
});
