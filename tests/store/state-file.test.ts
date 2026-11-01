import { beforeEach, describe, expect, it } from 'vitest';
import { analyze, dayOf as D } from '../../src/engine';
import { TaskmasterStore } from '../../src/store';
import { FakeObsidian } from './fake-obsidian';

let o: FakeObsidian;

const boot = async () => {
  const store = new TaskmasterStore(o.app, { today: () => D('2026-11-02') });
  await store.load();
  return store;
};

const task = (name: string, left: number) => o.add(`Projects/${name}.md`, { 'tm-type': 'item', 'tm-left': left });
const p = (name: string) => `Projects/${name}.md`;

beforeEach(() => {
  o = new FakeObsidian();
});

describe('state.json', () => {
  it('has safe defaults when missing', async () => {
    task('a', 6);
    const store = await boot();
    expect(store.state.settings).toEqual({ weekly: 30, staleDays: 7, holidays: [] });
    expect(store.state.plan).toEqual({});
    expect(store.state.planHistory).toEqual([]);
    expect(store.state.tiers).toEqual([[p('a')]]);
    expect(store.warnings).toEqual([]);
  });

  it('is the only file read at boot', async () => {
    o.stateJson = '{}';
    task('a', 6);
    await boot();
    expect(o.reads).toEqual(['_taskmaster/state.json']);
  });

  it('loads tiers, plan, history, capacity and holidays', async () => {
    task('a', 12);
    task('b', 12);
    o.stateJson = JSON.stringify({
      tiers: [[p('a')], [p('b')]],
      plan: { [p('a')]: { start: '2026-11-02', end: '2026-11-03', hours: 12 } },
      planHistory: [{ day: '2026-10-01', ids: [p('a')], before: { [p('a')]: null } }],
      capacity: 40,
      holidays: ['2026-12-24'],
    });
    const { state } = await boot();
    expect(state.tiers).toEqual([[p('a')], [p('b')]]);
    expect(state.plan[p('a')]).toEqual({ start: D('2026-11-02'), end: D('2026-11-03'), hours: 12 });
    expect(state.planHistory).toEqual([{ day: D('2026-10-01'), ids: [p('a')], before: { [p('a')]: undefined } }]);
    expect(state.settings).toEqual({ weekly: 40, staleDays: 7, holidays: [D('2026-12-24')] });
  });

  it('drives the scheduler: a 12h ranked above b 12h, a ends Tue 3 Nov, b Thu 5 Nov', async () => {
    task('a', 12);
    task('b', 12);
    o.stateJson = JSON.stringify({ tiers: [[p('a')], [p('b')]] });
    const { by } = analyze((await boot()).state);
    expect(by[p('a')].end).toBe(D('2026-11-03'));
    expect(by[p('b')].end).toBe(D('2026-11-05'));
  });

  it.each([
    ['broken JSON', '{ nope'],
    ['a non-object', '[1]'],
    ['null', 'null'],
  ])('falls back to defaults on %s, and warns', async (_, json) => {
    task('a', 6);
    o.stateJson = json;
    const store = await boot();
    expect(store.state.settings.weekly).toBe(30);
    expect(store.state.tiers).toEqual([[p('a')]]);
    expect(store.warnings).toEqual([expect.objectContaining({ path: '_taskmaster/state.json' })]);
  });

  it.each([
    ['tiers', 'x'],
    ['tiers', [[1], 'x']],
    ['plan', 5],
    ['plan', { 'Projects/a.md': { start: 'x', end: '2026-11-03', hours: 1 } }],
    ['plan', { 'Projects/a.md': { start: '2026-11-02', end: '2026-11-03', hours: 'many' } }],
    ['planHistory', 'x'],
    ['planHistory', [{ day: 'x', ids: [], before: {} }]],
    ['planHistory', [{ day: '2026-10-01', ids: 'x', before: {} }]],
    ['capacity', 'lots'],
    ['capacity', -5],
    ['capacity', 0],
    ['holidays', 'x'],
    ['holidays', ['2026-12-24', 'x']],
  ])('skips a bad %s (%j), and warns', async (field, value) => {
    task('a', 6);
    o.stateJson = JSON.stringify({ [field]: value });
    const store = await boot();
    expect(store.state.settings.weekly).toBeGreaterThan(0);
    expect(store.warnings).toContainEqual(expect.objectContaining({ path: '_taskmaster/state.json', field }));
    expect(() => analyze(store.state)).not.toThrow();
  });

  it('keeps good entries beside a bad one', async () => {
    o.stateJson = JSON.stringify({
      holidays: ['2026-12-24', 'x'],
      plan: { good: { start: '2026-11-02', end: '2026-11-03', hours: 1 }, bad: {} },
    });
    const { state } = await boot();
    expect(state.settings.holidays).toEqual([D('2026-12-24')]);
    expect(Object.keys(state.plan)).toEqual(['good']);
  });

  it('gives a path listed twice its highest level only', async () => {
    task('a', 6);
    o.stateJson = JSON.stringify({ tiers: [[p('a')], [p('a')]] });
    expect((await boot()).state.tiers).toEqual([[p('a')], []]);
  });
});

describe('levels against the notes', () => {
  it('puts new tasks in the last level and keeps empty levels', async () => {
    task('a', 6);
    task('new', 6);
    o.stateJson = JSON.stringify({ tiers: [[p('a')], []] });
    expect((await boot()).state.tiers).toEqual([[p('a')], [p('new')]]);
  });

  it('drops gone notes, finished tasks and parents', async () => {
    task('open', 6);
    task('finished', 0);
    task('parent', 6);
    o.add('Projects/child.md', { 'tm-type': 'item', 'tm-parent': '[[parent]]', 'tm-left': 3 });
    o.stateJson = JSON.stringify({ tiers: [[p('open'), p('finished'), p('parent'), p('gone')], [p('child')]] });
    expect((await boot()).state.tiers).toEqual([[p('open')], [p('child')]]);
  });

  it('keeps levels intact while the cache is still indexing', async () => {
    task('a', 6);
    o.addUnindexed('Projects/b.md');
    o.stateJson = JSON.stringify({ tiers: [[p('b')], [p('a')]] });
    expect((await boot()).state.tiers).toEqual([[p('b')], [p('a')]]);
  });
});
