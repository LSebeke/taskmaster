import { describe, expect, it } from 'vitest';
import { dayOf as D, type Item, type State } from '../../src/engine';
import { depChoices } from '../../src/view/deps';

const today = D('2026-11-02');
const state = (items: Record<string, Partial<Item>>): State => ({
  items: Object.fromEntries(Object.entries(items).map(([id, o]) => [id, { title: id, parent: null, kind: 'item', deps: [], left: 6, ...o }])),
  plan: {},
  tiers: [],
  today,
  settings: { weekly: 30, staleDays: 7, holidays: [] },
});
const flat = (st: State, id: string) => depChoices(st, id).flatMap(g => g.items.map(i => i.id));

describe('depChoices', () => {
  it('lists candidates under their parent path, paths and items alphabetical', () => {
    const st = state({
      Zeta: { left: 0 },
      Alpha: { left: 0 },
      z2: { parent: 'Zeta' },
      z1: { parent: 'Zeta' },
      Inner: { parent: 'Alpha', left: 0 },
      deep: { parent: 'Inner' },
      other: {},
    });
    const groups = depChoices(st, 'other');
    expect(groups.map(g => g.path)).toEqual(['Alpha', 'Alpha › Inner', 'Projects', 'Zeta']);
    expect(groups.find(g => g.path === 'Zeta')!.items.map(i => i.title)).toEqual(['z1', 'z2']);
    expect(groups.find(g => g.path === 'Projects')!.items.map(i => i.title)).toEqual(['Alpha', 'Zeta']);
  });

  it('sorts without regard to case', () => {
    const st = state({ b: {}, A: {}, C: {}, me: {} });
    expect(depChoices(st, 'me')[0].items.map(i => i.title)).toEqual(['A', 'b', 'C']);
  });

  it('leaves out itself, existing dependencies and anything that closes a cycle', () => {
    const st = state({ a: { deps: ['b'] }, b: { deps: ['c'] }, c: {}, free: {}, taken: {}, me: { deps: ['taken'] } });
    expect(flat(st, 'c').sort()).toEqual(['free', 'me', 'taken']);
    expect(flat(st, 'me').sort()).toEqual(['a', 'b', 'c', 'free']);
  });

  it('leaves out its own parents and children', () => {
    const st = state({ par: { left: 0 }, kid: { parent: 'par', left: 0 }, leaf: { parent: 'kid' }, other: {} });
    expect(flat(st, 'kid')).toEqual(['other']);
    expect(flat(st, 'leaf')).toEqual(['other']);
  });

  it('files external items under External, and offers milestones', () => {
    const st = state({ par: { left: 0 }, m: { kind: 'ms', parent: 'par' }, x: { kind: 'ext', pinS: today, pinE: today }, me: {} });
    const groups = depChoices(st, 'me');
    expect(groups.find(g => g.path === 'External')!.items.map(i => i.id)).toEqual(['x']);
    expect(groups.find(g => g.path === 'par')!.items.map(i => i.id)).toEqual(['m']);
  });
});
