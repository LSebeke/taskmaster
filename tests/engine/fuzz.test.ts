import { describe, expect, it } from 'vitest';
import { dayOf, schedule, weekOf, type Item, type ScheduleOptions, type State } from '../../src/engine';
import { perfSeed } from '../../dev/perf-seed';
import { schedule as reference } from './schedule-reference';

const TODAY = dayOf('2026-11-02');

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  return { chance: (p: number) => next() < p, int: (n: number) => Math.floor(next() * n) };
}

/** Everything the simulation branches on: both kinds of milestone, external items, pins of every kind, past and tight ones. */
function randomState(seed: number): State {
  const r = rng(seed);
  const items: Record<string, Item> = {};
  const base = () => ({ scope: (['must', 'should', 'could'] as const)[r.int(3)], deps: [] as string[], todos: [], notes: [] });
  const leaves: string[] = [];
  for (let p = 0, projects = 1 + r.int(3); p < projects; p++) {
    const P = `p${p}`;
    items[P] = { ...base(), title: P, parent: null, kind: 'item' };
    for (let i = 0, n = 2 + r.int(14); i < n; i++) {
      const id = `${P}.${i}`;
      const left = r.chance(0.15) ? 0 : 1 + r.int(40);
      const it: Item = { ...base(), title: id, parent: P, kind: r.chance(0.08) ? 'ms' : 'item', est: left || 8, spent: r.int(10), left };
      if (it.kind === 'ms') {
        it.left = undefined;
        if (r.chance(0.3)) it.pinE = TODAY + r.int(60) - 5;
        if (r.chance(0.1)) it.pinS = TODAY + r.int(30);
        if (r.chance(0.2)) Object.assign(it, { done: true, doneOn: TODAY - r.int(5) });
      } else {
        if (!left) it.doneOn = r.chance(0.1) ? TODAY + r.int(6) : r.chance(0.1) ? undefined : TODAY - 1 - r.int(5);
        if (r.chance(0.15)) it.pinE = TODAY + r.int(90) - 5;
        if (r.chance(0.12)) it.pinS = TODAY + r.int(40) - 5;
        if (it.pinS != null && it.pinE != null && it.pinE < it.pinS) it.pinE = it.pinS + r.int(10);
      }
      // Earlier leaves only, so there are no cycles.
      for (const d of leaves) if (r.chance(3 / (leaves.length + 2))) it.deps!.push(d);
      items[id] = it;
      leaves.push(id);
    }
  }
  for (let x = 0, n = r.int(3); x < n; x++) {
    const start = TODAY + r.int(50) - 10;
    items[`x${x}`] = { title: `x${x}`, parent: null, kind: 'ext', pinS: start, pinE: start + r.int(9), deps: [] };
    for (const l of leaves) if (r.chance(0.2)) items[l].deps!.push(`x${x}`);
  }
  // A dependency on a whole project, unless that is the task's own.
  if (items.p1) for (const l of leaves) if (l.startsWith('p2.') && r.chance(0.1)) items[l].deps!.push('p1');

  const open = leaves.filter(l => items[l].kind === 'item' && items[l].left! > 0).sort(() => (r.chance(0.5) ? 1 : -1));
  const levels = 1 + r.int(5);
  const tiers: string[][] = Array.from({ length: levels }, () => []);
  // Some open tasks are in no level at all: they run last.
  for (const l of open) if (!r.chance(0.1)) tiers[r.int(levels)].push(l);
  const holidays = r.chance(0.5) ? [TODAY + 3 + r.int(20), TODAY + 30 + r.int(20)] : [];
  const weekCap = r.chance(0.3) ? { [weekOf(TODAY) + r.int(4)]: r.int(60), [weekOf(TODAY) + 5]: 0 } : undefined;
  return { items, plan: {}, today: TODAY, settings: { weekly: [0, 8, 20, 30, 40, 80, 300][r.int(7)], staleDays: 7, holidays, weekCap }, tiers };
}

/** All of a schedule. Exact: a change in the last bit of a float fails. */
function expectSame(st: State, opt: ScheduleOptions, label: string) {
  const a = schedule(st, opt);
  const b = reference(st, opt);
  expect(a.rel, `${label}: release days`).toEqual(b.rel);
  expect([...a.noRoom], `${label}: no room`).toEqual([...b.noRoom]);
  expect(a.C.ids, `${label}: tasks`).toEqual(b.C.ids);
  expect({ ...a.r }, label).toEqual({ ...b.r });
}

describe('fast schedule vs. the frozen reference', () => {
  it('generates what the simulation branches on', () => {
    const states = Array.from({ length: 300 }, (_, i) => randomState(i + 1));
    const seen = states.map(st => schedule(st));
    expect(seen.filter(s => Object.keys(s.rel).length > 0).length).toBeGreaterThan(100);
    expect(seen.filter(s => s.noRoom.size > 0).length).toBeGreaterThan(30);
    expect(seen.filter(s => s.r.over.length > 0).length).toBeGreaterThan(10);
    expect(seen.filter(s => s.r.idleBy.some(x => x >= 0)).length).toBeGreaterThan(100);
    expect(seen.filter(s => s.r.fin.includes(-1)).length).toBeGreaterThan(10);
  });

  it('300 random schedules', () => {
    for (let seed = 1; seed <= 300; seed++) expectSame(randomState(seed), {}, `seed ${seed}`);
  });

  it('with tasks excluded and hours scaled, as the signals run it', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const st = randomState(seed);
      expectSame(st, { exclude: new Set(['x0', 'p0.0', 'p0.1']) }, `seed ${seed} exclude`);
      expectSame(st, { scale: id => (id.startsWith('p0') ? 1.37 : 1) }, `seed ${seed} scale`);
    }
  });

  it('the perf scenarios', () => {
    expectSame(perfSeed({ tasks: 300, endPinned: 0.05 }), {}, 'one a week');
    expectSame(perfSeed({ tasks: 300, weekly: 100, endPinned: 0.1 }), {}, 'tight pins');
    expectSame(perfSeed({ tasks: 300, weekly: 100, endPinned: 0.1, levels: 3 }), {}, 'one long level');
  });
});
