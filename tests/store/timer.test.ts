import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayOf as D } from '../../src/engine';
import { TaskmasterStore } from '../../src/store';
import { FakeObsidian } from './fake-obsidian';

const p = (name: string) => `Projects/${name}.md`;
const task = (left = 12, extra = {}) => ({ 'tm-type': 'item', 'tm-estimate': left, 'tm-left': left, ...extra });
const HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 2, 9);

let o: FakeObsidian;
let store: TaskmasterStore;
let now: number;

const boot = async () => {
  store = new TaskmasterStore(o.app, { today: () => D('2026-11-02'), now: () => now, debounceMs: 100, writeMs: 300 });
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

beforeEach(() => {
  vi.useFakeTimers();
  o = new FakeObsidian();
  o.folders.add('Projects');
  now = START;
  o.add(p('a'), task());
  o.add(p('b'), task());
});

afterEach(() => {
  store.dispose();
  vi.useRealTimers();
});

describe('timer', () => {
  it('runs on one task, and says so', async () => {
    await boot();
    expect(store.timer).toBeNull();
    expect(store.startTimer(p('a'))).toBe(true);
    expect(store.timer).toEqual({ id: p('a'), since: START });
  });

  it('a second task cannot start while one runs', async () => {
    await boot();
    store.startTimer(p('a'));
    expect(store.startTimer(p('b'))).toBe(false);
    expect(store.timer?.id).toBe(p('a'));
  });

  it('runs only on a task with hours left', async () => {
    o.add(p('draft'), { 'tm-type': 'item' });
    o.add(p('done'), task(0, { 'tm-log': ['2026-11-01 3'] }));
    o.add('Projects/P/P.md', task(0));
    o.add('Projects/P/c.md', task(6, { 'tm-parent': '[[P]]' }));
    o.add('Projects/P/m.md', { 'tm-type': 'milestone', 'tm-parent': '[[P]]' });
    o.add('Projects/_external/x.md', { 'tm-type': 'external', 'tm-pin-start': '2026-11-02', 'tm-pin-end': '2026-11-03' });
    await boot();
    for (const id of [p('draft'), p('done'), 'Projects/P/P.md', 'Projects/P/m.md', 'Projects/_external/x.md', p('gone')]) expect(store.startTimer(id)).toBe(false);
    expect(store.timer).toBeNull();
  });

  it('survives a reload, and keeps counting from its start', async () => {
    await boot();
    store.startTimer(p('a'));
    await settle();
    expect(stateFile().timer).toEqual({ id: p('a'), since: '2026-11-02T09:00:00.000Z' });
    store.dispose();
    now = START + 2 * HOUR;
    await boot();
    expect(store.timer).toEqual({ id: p('a'), since: START });
    expect(store.stopTimer()).toMatchObject({ id: p('a'), hours: 2 });
  });

  it('stop writes a log entry for the time run, moving hours from left to spent', async () => {
    await boot();
    store.startTimer(p('a'));
    now = START + 1.5 * HOUR;
    expect(store.stopTimer()).toEqual({ id: p('a'), hours: 1.5 });
    expect(store.timer).toBeNull();
    expect(store.state.items[p('a')]).toMatchObject({ spent: 1.5, left: 10.5 });
    await settle();
    expect(o.frontmatter(p('a'))).toMatchObject({ 'tm-log': ['2026-11-02 1.5'], 'tm-left': 10.5, 'tm-left-updated': '2026-11-02' });
    expect(stateFile().timer).toBeUndefined();
  });

  it('adds to the entry a day already has', async () => {
    o.add(p('c'), task(10, { 'tm-log': ['2026-11-02 1'] }));
    await boot();
    store.startTimer(p('c'));
    now = START + 2 * HOUR;
    store.stopTimer();
    await settle();
    expect(o.frontmatter(p('c'))['tm-log']).toEqual(['2026-11-02 3']);
  });

  it('a few seconds write nothing', async () => {
    await boot();
    store.startTimer(p('a'));
    now = START + 10_000;
    expect(store.stopTimer()).toEqual({ id: p('a'), hours: 0 });
    expect(store.timer).toBeNull();
    expect(store.state.items[p('a')].spent).toBe(0);
  });

  it('stop with nothing running does nothing', async () => {
    await boot();
    expect(store.stopTimer()).toBeNull();
    expect(store.undoLabel).toBeNull();
  });

  it('undoing the stop takes the entry back and the timer runs on', async () => {
    await boot();
    store.startTimer(p('a'));
    now = START + HOUR;
    store.stopTimer();
    await store.undo();
    expect(store.state.items[p('a')]).toMatchObject({ spent: 0, left: 12 });
    expect(store.timer).toEqual({ id: p('a'), since: START });
  });

  it('follows its task through a rename', async () => {
    await boot();
    store.startTimer(p('a'));
    await store.rename(p('a'), 'z');
    expect(store.timer?.id).toBe(p('z'));
    await settle();
    expect(stateFile().timer.id).toBe(p('z'));
  });

  it('deleting the task ends it, with no entry; undo brings it back', async () => {
    await boot();
    store.startTimer(p('a'));
    await store.remove(p('a'));
    expect(store.timer).toBeNull();
    await settle();
    expect(stateFile().timer).toBeUndefined();
    await store.undo();
    await settle();
    expect(store.timer).toEqual({ id: p('a'), since: START });
  });

  it('a note gone behind its back shows no timer, and another can start', async () => {
    await boot();
    store.startTimer(p('a'));
    o.remove(p('a'));
    await vi.advanceTimersByTimeAsync(100);
    expect(store.timer).toBeNull();
    expect(store.stopTimer()).toBeNull();
    expect(store.startTimer(p('b'))).toBe(true);
  });

  it('a task that gained children logs nothing: hours go on tasks only', async () => {
    await boot();
    store.startTimer(p('a'));
    const { id: child } = await store.create({ kind: 'item', title: 'c', parent: p('a'), hours: 3 });
    const parent = store.state.items[child!].parent!;
    now = START + HOUR;
    expect(store.stopTimer()).toEqual({ id: parent, hours: 0 });
    expect(store.timer).toBeNull();
    expect(store.state.items[parent].log ?? []).toEqual([]);
  });

  it('listeners hear of it', async () => {
    await boot();
    const heard: (string | undefined)[] = [];
    store.subscribe((_, label) => heard.push(label));
    store.startTimer(p('a'));
    expect(heard).toEqual(['Timer started on a']);
  });

});
