import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyze, dayOf as D, isoWeekKey, weekOf, type State } from '../../src/engine';
import {
  addDep,
  deleteLogEntry,
  editLogEntry,
  logHours,
  removeDep,
  setBudget,
  setDeadline,
  setHoursLeft,
  setPin,
  setPins,
  setScope,
  setTotal,
  setWeekCapacity,
  setWeekly,
  STATE_PATH,
  TaskmasterStore,
} from '../../src/store';
import { FakeObsidian } from './fake-obsidian';

const WRITE = 300;
const NOV2 = D('2026-11-02');
const p = (name: string) => `Projects/${name}.md`;
const item = (left = 12, extra = {}) => ({ 'tm-type': 'item', 'tm-left': left, ...extra });

let o: FakeObsidian;
let store: TaskmasterStore;
let today: number;
let events: (string | undefined)[];

const it_ = (name: string) => store.state.items[p(name)];
const boot = async () => {
  store = new TaskmasterStore(o.app, { today: () => today, debounceMs: 100, writeMs: WRITE });
  await store.load();
  await vi.advanceTimersByTimeAsync(0);
  events = [];
  store.subscribe((_, label) => events.push(label));
};
const passWrite = () => vi.advanceTimersByTimeAsync(WRITE);
const settle = async () => {
  await passWrite();
  o.deliver();
  await vi.advanceTimersByTimeAsync(100);
};
const stateFile = () => JSON.parse(o.stateJson!);

beforeEach(() => {
  vi.useFakeTimers();
  o = new FakeObsidian();
  today = NOV2;
});

afterEach(() => {
  store.dispose();
  vi.useRealTimers();
});

describe('hours (spec acceptance)', () => {
  it('log on an unstarted task: start unchanged, spent 3, left 9', async () => {
    o.add(p('z'), item(30, { 'tm-pin-start': '2026-11-09' }));
    await boot();
    store.apply(logHours(p('z'), NOV2, 3));
    expect(it_('z')).toMatchObject({ spent: 3, left: 27 });
    await settle();
    expect(o.frontmatter(p('z'))).toMatchObject({ 'tm-left': 27, 'tm-log': ['2026-11-02 3'], 'tm-left-updated': '2026-11-02' });
    expect(o.frontmatter(p('z'))['tm-started']).toBeUndefined();
    expect(analyze(store.state).results[p('z')].start).toBe(D('2026-11-09'));
  });

  it('editing that entry to 1h, then deleting it', async () => {
    o.add(p('b'), item(12));
    await boot();
    store.apply(logHours(p('b'), NOV2, 3));
    store.apply(editLogEntry(p('b'), 0, 1));
    expect(it_('b')).toMatchObject({ spent: 1, left: 11 });
    store.apply(deleteLogEntry(p('b'), 0));
    expect(it_('b')).toMatchObject({ spent: 0, left: 12 });
    await settle();
    expect(o.frontmatter(p('b'))['tm-log']).toEqual([]);
  });

  it('spent 2, set total 20 leaves 18; total stays out of the estimate', async () => {
    o.add(p('a'), item(6, { 'tm-log': ['2026-10-30 2'], 'tm-estimate': 8 }));
    await boot();
    store.apply(setTotal(p('a'), 20));
    expect(it_('a')).toMatchObject({ spent: 2, left: 18, est: 8 });
  });

  it('spent 2, set total 1: done and out of the levels. Total 10 reopens it into the last level', async () => {
    o.add(p('a'), item(6, { 'tm-log': ['2026-10-30 2'] }));
    o.add(p('other'), item(6));
    o.stateJson = JSON.stringify({ tiers: [[p('a')], [p('other')]] });
    await boot();
    store.apply(setTotal(p('a'), 1));
    expect(it_('a').left).toBe(0);
    expect(it_('a').doneOn).toBe(NOV2);
    expect(store.state.tiers).toEqual([[], [p('other')]]);
    store.apply(setTotal(p('a'), 10));
    expect(it_('a').left).toBe(8);
    expect(it_('a').doneOn).toBeUndefined();
    expect(store.state.tiers).toEqual([[], [p('other'), p('a')]]);
    await passWrite();
    expect(stateFile().tiers).toEqual([[], [p('other'), p('a')]]);
  });

  it('hours left is set directly; 0 marks done', async () => {
    o.add(p('a'), item(6, { 'tm-log': ['2026-10-30 2'] }));
    await boot();
    store.apply(setHoursLeft(p('a'), 0));
    expect(analyze(store.state).results[p('a')].done).toBe(true);
    expect(it_('a').left).toBe(0);
  });

  it('a draft given hours gets them as its estimate, and joins the last level', async () => {
    o.add(p('d'), { 'tm-type': 'item' });
    await boot();
    store.apply(setTotal(p('d'), 16));
    expect(it_('d')).toMatchObject({ left: 16, est: 16 });
    expect(store.state.tiers.flat()).toContain(p('d'));
  });

  it('keeps hand-written log entries it cannot parse', async () => {
    o.add(p('a'), item(6, { 'tm-log': ['yesterday-ish 2', '2026-10-30 2'] }));
    await boot();
    store.apply(logHours(p('a'), NOV2, 1));
    await settle();
    expect(o.frontmatter(p('a'))['tm-log']).toEqual(['yesterday-ish 2', '2026-10-30 2', '2026-11-02 1']);
  });

  it('does not write float dust', async () => {
    o.add(p('a'), item(1));
    await boot();
    store.apply(logHours(p('a'), NOV2, 0.1));
    store.apply(logHours(p('a'), NOV2, 0.2));
    await settle();
    expect(o.frontmatter(p('a'))['tm-left']).toBe(0.7);
    expect(o.frontmatter(p('a'))['tm-log']).toEqual(['2026-11-02 0.3']);
  });
});

describe('pins, deadline, scope, budget', () => {
  it('pins each edge and returns it to Auto', async () => {
    o.add(p('a'), item(12));
    await boot();
    store.apply(setPin(p('a'), 'start', D('2026-11-05')));
    await settle();
    expect(o.frontmatter(p('a'))['tm-pin-start']).toBe('2026-11-05');
    store.apply(setPin(p('a'), 'start', null));
    await settle();
    expect('tm-pin-start' in o.frontmatter(p('a'))).toBe(false);
    expect(it_('a').pinS).toBeUndefined();
  });

  it('a pin cannot pass the other pin', async () => {
    o.add(p('a'), item(12, { 'tm-pin-start': '2026-11-05', 'tm-pin-end': '2026-11-10' }));
    await boot();
    store.apply(setPin(p('a'), 'start', D('2026-11-20')));
    expect(it_('a').pinS).toBe(D('2026-11-10'));
    store.apply(setPin(p('a'), 'end', D('2026-11-01')));
    expect(it_('a').pinE).toBe(D('2026-11-10'));
  });

  it('a milestone keeps its date under tm-pin-end, clearing either key', async () => {
    o.add(p('par'), { 'tm-type': 'item' });
    o.add(p('m'), { 'tm-type': 'milestone', 'tm-parent': '[[par]]', 'tm-pin-start': '2026-11-20' });
    await boot();
    store.apply(setPin(p('m'), 'end', null));
    await settle();
    expect(o.frontmatter(p('m'))).not.toHaveProperty('tm-pin-start');
    expect(it_('m').pinE).toBeUndefined();
  });

  it('a drag pins the edges it moved, and moves an external item', async () => {
    o.add(p('a'), item(12));
    o.add(p('x'), { 'tm-type': 'external', 'tm-pin-start': '2026-11-02', 'tm-pin-end': '2026-11-04' });
    await boot();
    store.apply(setPins(p('a'), { e: D('2026-11-13') }));
    expect(it_('a')).toMatchObject({ pinE: D('2026-11-13') });
    expect(it_('a').pinS).toBeUndefined();
    store.apply(setPins(p('x'), { s: D('2026-11-03'), e: D('2026-11-05') }));
    await settle();
    expect(o.frontmatter(p('x'))).toMatchObject({ 'tm-pin-start': '2026-11-03', 'tm-pin-end': '2026-11-05' });
  });

  it('sets and clears deadline, budget and scope', async () => {
    o.add(p('a'), item(12));
    await boot();
    store.apply(setDeadline(p('a'), D('2026-12-01')));
    store.apply(setBudget(p('a'), 90));
    store.apply(setScope(p('a'), 'could'));
    await settle();
    expect(o.frontmatter(p('a'))).toMatchObject({ 'tm-deadline': '2026-12-01', 'tm-budget': 90, 'tm-scope': 'could' });
    store.apply(setDeadline(p('a'), null));
    store.apply(setBudget(p('a'), null));
    await settle();
    expect(o.frontmatter(p('a'))).not.toHaveProperty('tm-deadline');
    expect(o.frontmatter(p('a'))).not.toHaveProperty('tm-budget');
  });

  it('an edit that changes nothing leaves no undo step', async () => {
    o.add(p('a'), item(12, { 'tm-scope': 'could' }));
    await boot();
    expect(store.apply(setScope(p('a'), 'could'))).toBe(false);
    expect(store.undoLabel).toBeNull();
    expect(events).toEqual([]);
  });
});

describe('dependencies', () => {
  it('adds a link Obsidian can follow and removes it again', async () => {
    o.add(p('a'), item(6));
    o.add(p('b'), item(6));
    await boot();
    store.apply(addDep(p('b'), p('a')));
    expect(it_('b').deps).toEqual([p('a')]);
    await settle();
    expect(o.frontmatter(p('b'))['tm-deps']).toEqual(['[[a]]']);
    store.apply(removeDep(p('b'), p('a')));
    await settle();
    expect(o.frontmatter(p('b'))['tm-deps']).toEqual([]);
  });

  it('uses the full path when the name is not unique', async () => {
    o.add('Projects/x/same.md', item(6));
    o.add('Projects/y/same.md', item(6));
    o.add(p('b'), item(6));
    await boot();
    store.apply(addDep(p('b'), 'Projects/y/same.md'));
    await settle();
    expect(o.frontmatter(p('b'))['tm-deps']).toEqual(['[[Projects/y/same]]']);
    expect(it_('b').deps).toEqual(['Projects/y/same.md']);
  });

  it('keeps the links already in the note exactly as written', async () => {
    o.add(p('a'), item(6));
    o.add(p('c'), item(6));
    o.add(p('b'), item(6, { 'tm-deps': ['[[c|the c]]', '[[nowhere]]'] }));
    await boot();
    store.apply(addDep(p('b'), p('a')));
    await settle();
    expect(o.frontmatter(p('b'))['tm-deps']).toEqual(['[[c|the c]]', '[[nowhere]]', '[[a]]']);
    store.apply(removeDep(p('b'), p('c')));
    await settle();
    expect(o.frontmatter(p('b'))['tm-deps']).toEqual(['[[nowhere]]', '[[a]]']);
  });

  it('refuses a cycle', async () => {
    o.add(p('a'), item(6, { 'tm-deps': ['[[b]]'] }));
    o.add(p('b'), item(6));
    await boot();
    expect(store.apply(addDep(p('b'), p('a')))).toBe(false);
    expect(it_('b').deps).toEqual([]);
  });
});

describe('state.json', () => {
  it('writes atomically in the format it reads, weekCapacity included', async () => {
    o.add(p('a'), item(12));
    o.stateJson = JSON.stringify({ plan: { [p('a')]: { start: '2026-11-02', end: '2026-11-03', hours: 12 } }, holidays: ['2026-12-24'] });
    await boot();
    const week = weekOf(D('2026-12-07'));
    store.apply(setWeekly(40));
    store.apply(setWeekCapacity(week, 50));
    expect(store.state.settings.weekCap).toEqual({ [week]: 50 });
    expect(o.adapterWrites).toEqual([]);
    await passWrite();
    expect(o.adapterWrites).toEqual([`${STATE_PATH}.tmp`]);
    expect(o.files.has(`${STATE_PATH}.tmp`)).toBe(false);
    expect(stateFile()).toEqual({
      tiers: [[p('a')]],
      plan: { [p('a')]: { start: '2026-11-02', end: '2026-11-03', hours: 12 } },
      planHistory: [],
      capacity: 40,
      staleDays: 7,
      projectsFolder: 'Projects/',
      weekCapacity: { [isoWeekKey(week)]: 50 },
      holidays: ['2026-12-24'],
    });
    store.dispose();
    const again = new TaskmasterStore(o.app, { today: () => today });
    await again.load();
    expect(again.state.settings).toMatchObject({ weekly: 40, weekCap: { [week]: 50 } });
    again.dispose();
  });

  it('creates its folder on the first write', async () => {
    o.add(p('a'), item(12));
    await boot();
    store.apply(setWeekly(35));
    await passWrite();
    expect(stateFile().capacity).toBe(35);
  });

  it('a capacity edit fires listeners; a cleared override removes the key', async () => {
    o.add(p('a'), item(12));
    await boot();
    const week = weekOf(NOV2);
    store.apply(setWeekCapacity(week, 0));
    expect(events).toHaveLength(1);
    expect(store.state.settings.weekCap).toEqual({ [week]: 0 });
    store.apply(setWeekCapacity(week, null));
    await passWrite();
    expect(stateFile().weekCapacity).toEqual({});
  });

  it('recovers the new file when a swap never finished', async () => {
    o.add(p('a'), item(12));
    o.folders.add('_taskmaster');
    o.files.set(`${STATE_PATH}.tmp`, JSON.stringify({ capacity: 33 }));
    await boot();
    expect(store.state.settings.weekly).toBe(33);
  });

  it('keeps a copy of a state.json it cannot parse', async () => {
    o.add(p('a'), item(12));
    o.stateJson = '{ "capacity": oops';
    await boot();
    store.apply(setWeekly(35));
    await passWrite();
    expect(stateFile().capacity).toBe(35);
    expect(o.files.get(`${STATE_PATH}.bad`)).toBe('{ "capacity": oops');
  });

  it('persists plan keys on rename, and writes nothing for unrelated notes', async () => {
    o.add(p('a'), item(12));
    o.add('Elsewhere/n.md');
    o.stateJson = JSON.stringify({ tiers: [[p('a')]], plan: { [p('a')]: { start: '2026-11-02', end: '2026-11-03', hours: 12 } } });
    await boot();
    o.rename('Elsewhere/n.md', 'Elsewhere/m.md');
    await passWrite();
    expect(o.adapterWrites).toEqual([]);
    o.rename(p('a'), p('b'));
    await passWrite();
    expect(Object.keys(stateFile().plan)).toEqual([p('b')]);
    expect(stateFile().tiers).toEqual([[p('b')]]);
  });

  it('never writes state.json just by loading', async () => {
    o.add(p('a'), item(12));
    await boot();
    await vi.advanceTimersByTimeAsync(5000);
    expect(o.adapterWrites).toEqual([]);
  });
});

describe('undo', () => {
  it('reverts note edits exactly, one step at a time', async () => {
    o.add(p('a'), item(6, { 'tm-left-updated': '2026-10-01', 'tm-deps': ['[[c|the c]]'] }));
    o.add(p('c'), item(6));
    await boot();
    store.apply(setTotal(p('a'), 20));
    store.apply(setPin(p('a'), 'end', D('2026-12-01')));
    await settle();
    expect(await store.undo()).toMatch(/pinned/);
    await settle();
    expect(o.frontmatter(p('a'))).not.toHaveProperty('tm-pin-end');
    expect(o.frontmatter(p('a'))['tm-left']).toBe(20);
    await store.undo();
    await settle();
    expect(o.frontmatter(p('a'))).toMatchObject({ 'tm-left': 6, 'tm-left-updated': '2026-10-01', 'tm-deps': ['[[c|the c]]'] });
    expect(await store.undo()).toBeNull();
  });

  it('shows an undo at once, with one event, and undoes before the first write', async () => {
    o.add(p('a'), item(6));
    await boot();
    store.apply(setTotal(p('a'), 20));
    await store.undo();
    expect(it_('a').left).toBe(6);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatch(/^Undid/);
    await settle();
    expect(o.frontmatter(p('a'))['tm-left']).toBe(6);
    expect(events).toHaveLength(2);
  });

  it('reverts capacity and overrides in state.json', async () => {
    o.add(p('a'), item(6));
    await boot();
    const week = weekOf(NOV2);
    store.apply(setWeekly(35));
    store.apply(setWeekCapacity(week, 50));
    await store.undo();
    await store.undo();
    expect(store.state.settings).toMatchObject({ weekly: 30, weekCap: {} });
    await passWrite();
    expect(stateFile()).toMatchObject({ capacity: 30, weekCapacity: {} });
  });

  it('puts a finished task back on its old level', async () => {
    o.add(p('a'), item(6, { 'tm-log': ['2026-10-30 2'] }));
    o.add(p('b'), item(6));
    o.stateJson = JSON.stringify({ tiers: [[p('a')], [p('b')]] });
    await boot();
    store.apply(setTotal(p('a'), 1));
    expect(store.state.tiers).toEqual([[], [p('b')]]);
    await store.undo();
    expect(store.state.tiers).toEqual([[p('a')], [p('b')]]);
    await passWrite();
    expect(stateFile().tiers).toEqual([[p('a')], [p('b')]]);
  });

  it('covers any edit the same way: an edit written inline needs no undo code', async () => {
    o.add(p('a'), item(6));
    o.add(p('b'), item(6));
    o.stateJson = JSON.stringify({ tiers: [[p('a')], [p('b')]] });
    await boot();
    store.apply((st: State) => {
      st.tiers = [[p('a'), p('b')], []];
      return 'Moved to Priority 1';
    });
    expect(store.undoLabel).toBe('Moved to Priority 1');
    await passWrite();
    expect(stateFile().tiers).toEqual([[p('a'), p('b')], []]);
    await store.undo();
    await passWrite();
    expect(stateFile().tiers).toEqual([[p('a')], [p('b')]]);
  });

  it('still reverts after the note was renamed', async () => {
    o.add(p('a'), item(6));
    await boot();
    store.apply(setTotal(p('a'), 20));
    store.apply((st: State) => {
      st.tiers = [[], [p('a')]];
      return 'Moved';
    });
    await settle();
    o.rename(p('a'), p('b'));
    await vi.advanceTimersByTimeAsync(100);
    await store.undo();
    expect(store.state.tiers).toEqual([[p('b')]]);
    await store.undo();
    await settle();
    expect(o.frontmatter(p('b'))['tm-left']).toBe(6);
  });

  it('takes steps recorded by file work, and groups them into one', async () => {
    o.add(p('a'), item(6));
    await boot();
    const reverted: string[] = [];
    await store.group('Moved a', async () => {
      store.apply(setTotal(p('a'), 7));
      store.record({ label: 'file moved', undo: () => void reverted.push('file') });
    });
    expect(store.undoLabel).toBe('Moved a');
    await store.undo();
    expect(reverted).toEqual(['file']);
    expect(it_('a').left).toBe(6);
    expect(store.undoLabel).toBeNull();
  });
});

describe('dates that become facts', () => {
  it('a log on or after the forecast start sets tm-started, and undo takes it back', async () => {
    o.add(p('a'), item(12));
    await boot();
    store.apply(logHours(p('a'), NOV2, 3));
    expect(it_('a').actualStart).toBe(NOV2);
    await settle();
    expect(o.frontmatter(p('a'))['tm-started']).toBe('2026-11-02');
    await store.undo();
    await settle();
    expect(o.frontmatter(p('a'))).not.toHaveProperty('tm-started');
    expect(it_('a').actualStart).toBeUndefined();
  });

  it('a log dated before the forecast start starts the task on that start', async () => {
    o.add(p('a'), item(12));
    await boot();
    store.apply(logHours(p('a'), D('2026-10-30'), 3));
    expect(it_('a').actualStart).toBe(NOV2);
  });

  it('today reaching the start of a task with hours logged sets tm-started', async () => {
    o.add(p('z'), item(30, { 'tm-pin-start': '2026-11-03', 'tm-log': ['2026-11-02 3'] }));
    await boot();
    expect(it_('z').actualStart).toBeUndefined();
    today = D('2026-11-03');
    await vi.advanceTimersByTimeAsync(61_000);
    expect(it_('z').actualStart).toBe(D('2026-11-03'));
    await settle();
    expect(o.frontmatter(p('z'))['tm-started']).toBe('2026-11-03');
    expect(store.undoLabel).toBeNull();
  });

  it('a task with no hours logged has not started, however late it is', async () => {
    o.add(p('z'), item(30));
    await boot();
    today = D('2026-11-05');
    await vi.advanceTimersByTimeAsync(61_000);
    expect(it_('z').actualStart).toBeUndefined();
  });

  it('a milestone records tm-done with the date it passed, once', async () => {
    o.add(p('par'), { 'tm-type': 'item' });
    o.add(p('m'), { 'tm-type': 'milestone', 'tm-parent': '[[par]]', 'tm-pin-end': '2026-11-03' });
    await boot();
    expect(o.frontmatter(p('m'))).not.toHaveProperty('tm-done');
    today = D('2026-11-04');
    await vi.advanceTimersByTimeAsync(61_000);
    await settle();
    expect(o.frontmatter(p('m'))['tm-done']).toBe('2026-11-03');
    expect(it_('m').done).toBe(true);
    const writes = o.writes.length;
    today = D('2026-11-05');
    await vi.advanceTimersByTimeAsync(61_000);
    await settle();
    expect(o.writes).toHaveLength(writes);
  });

  it('records dates missed while Obsidian was closed, on load', async () => {
    o.add(p('par'), { 'tm-type': 'item' });
    o.add(p('m'), { 'tm-type': 'milestone', 'tm-parent': '[[par]]', 'tm-pin-end': '2026-10-20' });
    await boot();
    await settle();
    expect(o.frontmatter(p('m'))['tm-done']).toBe('2026-10-20');
  });

  it('holds off while the cache is still indexing', async () => {
    o.add(p('par'), { 'tm-type': 'item' });
    o.add(p('m'), { 'tm-type': 'milestone', 'tm-parent': '[[par]]', 'tm-pin-end': '2026-10-20' });
    o.addUnindexed(p('later'));
    await boot();
    await settle();
    expect(o.frontmatter(p('m'))).not.toHaveProperty('tm-done');
  });
});
