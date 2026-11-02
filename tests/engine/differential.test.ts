import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Port from '../../src/engine';
import type { State } from '../../src/engine';

/** Runs the prototype's own engine and seed data, read from the html at test time. */
function loadPrototype() {
  const html = readFileSync(new URL('../../prototype/taskmaster-prototype.html', import.meta.url), 'utf8');
  const block = (id: string) => html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`))![1];
  const ctx = createContext({}) as Record<string, any>;
  runInContext(`${block('engine')}${block('data')};this.Engine=Engine;this.seed=seed;this.stressData=stressData;`, ctx);
  return ctx;
}

const proto = loadPrototype();
const E = proto.Engine;
const ROOTS = ['gw', 'rig', 'dp'];

/** JSON keeps values comparable across vm realms. Infinity would otherwise turn into null. */
const plain = (x: unknown) => JSON.parse(JSON.stringify(x, (_, v) => (v === Infinity ? 'Infinity' : v)));
const seedState = (): State => plain(proto.seed());

/** Spec deviations excluded from state comparison: history skips external items, levels drop finished tasks. */
const comparable = (st: State) => ({
  items: st.items,
  itemOrder: Object.keys(st.items),
  plan: st.plan,
  today: st.today,
  tiers: st.tiers.map(t => t.filter(id => st.items[id]?.left! > 0)),
});

function expectSameResults(a: State, b: State) {
  expect(plain(comparable(b))).toEqual(plain(comparable(a)));
  expect(plain(Port.analyze(b))).toEqual(plain(E.analyze(a)));
}

describe('differential: prototype engine vs. port on seed data', () => {
  it('analyze', () => {
    const st = proto.seed();
    expect(Object.keys(st.items).length).toBeGreaterThan(30);
    expect(plain(Port.analyze(seedState()))).toEqual(plain(E.analyze(st)));
  });

  it('MVP, accuracy, adjusted finish', () => {
    const a = proto.seed();
    const b = seedState();
    for (const root of ROOTS) {
      expect(plain(Port.mvp(b, root))).toEqual(plain(E.mvp(a, root)));
      expect(plain(Port.accuracy(b, root))).toEqual(plain(E.accuracy(a, root)));
      expect(plain(Port.adjusted(b, root, 1.37))).toEqual(plain(E.adjusted(a, root, 1.37)));
    }
  });

  it('external effect, including a slipped external item', () => {
    const a = proto.seed();
    const b = seedState();
    expect(plain(Port.externalImpact(b, 'x.bench'))).toEqual(plain(E.externalImpact(a, 'x.bench')));
    a.items['x.bench'].pinE = b.items['x.bench'].pinE = Port.dayOf('2026-12-18');
    const fx = Port.externalImpact(b, 'x.bench');
    expect(fx.items.some(i => i.days > 0)).toBe(true);
    expect(plain(fx)).toEqual(plain(E.externalImpact(a, 'x.bench')));
  });

  it('dependency helpers on every item', () => {
    const a = proto.seed();
    const b = seedState();
    const Ka = E.kids(a);
    const Kb = Port.kids(b);
    const ids = Object.keys(b.items);
    expect(plain(Kb)).toEqual(plain(Ka));
    for (const id of ids) {
      expect(plain(Port.effDeps(b, id, Kb))).toEqual(plain(E.effDeps(a, id, Ka)));
      expect(Port.rootOf(b, id)).toBe(E.rootOf(a, id));
      const blockedA = E.depBlocker(a, id);
      const blockedB = Port.depBlocker(b, id);
      expect(ids.filter(blockedB)).toEqual(ids.filter(x => blockedA(x)));
    }
  });

  it('stress data, 1000 tasks', () => {
    const st = proto.stressData();
    expect(plain(Port.analyze(plain(st)))).toEqual(plain(E.analyze(st)));
  });

  it.each([
    ['logging as forecast', false],
    ['burning without progress', true],
  ])('every day of 60 working days, %s', (_, burnsOnly) => {
    const st = proto.seed();
    for (let i = 0; i < 60; i++) {
      // The prototype never calls a task stale without this date. The port counts from the start.
      for (const it of Object.values<any>(st.items)) if (it.actualStart != null) it.touched ??= it.actualStart;
      const a = E.analyze(st);
      expect(plain(Port.analyze(plain(st)))).toEqual(plain(a));
      E.advanceDay(st, a, burnsOnly);
    }
  });

  it('moveError for every item and target', () => {
    const a = proto.seed();
    const b = seedState();
    const ids = Object.keys(b.items);
    for (const id of ids)
      for (const parent of [null, ...ids]) expect(Port.moveError(b, id, parent)).toBe(E.moveError(a, id, parent));
  });
});

describe('differential: the same edits on both sides', () => {
  let a: any;
  let b: State;
  const both = (edit: (Engine: any, st: any) => void) => {
    edit(E, a);
    edit(Port, b);
    E.ensureTiers(a);
    Port.ensureTiers(b);
    expectSameResults(a, b);
  };

  beforeEach(() => {
    a = proto.seed();
    b = seedState();
  });

  it('hours: log, edit, total', () => {
    both((X, s) => X.logHours(s.items['dp.etl'], s.today, 3.5, s.today));
    both((X, s) => X.logHours(s.items['dp.etl'], s.today, 1, s.today));
    both((X, s) => X.logHours(s.items['gw.fw.drv.can'], s.today, 2, s.today));
    both((X, s) => X.editLog(s.items['gw.fw.drv.can'], 0, 1, s.today));
    both((X, s) => X.editLog(s.items['gw.fw.drv.can'], 0, 0, s.today));
    both((X, s) => X.setTotal(s.items['dp.back'], 40, s.today));
    both((X, s) => X.setLeft(s.items['dp.doc'], 0, s.today));
  });

  it('priority levels', () => {
    both((X, s) => (s.tiers = X.addTier(s.tiers, 0)));
    both((X, s) => (s.tiers = X.moveToTier(s.tiers, 'rig.fx.py', 0)));
    both((X, s) => (s.tiers = X.moveToTier(s.tiers, 'dp.etl', 1, 'gw.hw.can')));
    both((X, s) => (s.tiers = X.addTier(s.tiers, 2)));
    both((X, s) => (s.tiers = X.removeTier(s.tiers, 2)));
    both((X, s) => (s.tiers = X.removeTier(s.tiers, 0)));
  });

  it('pins', () => {
    both((_, s) => (s.items['gw.fw.pr.ota'].pinS = s.today + 10));
    both((_, s) => (s.items['gw.fw.pr.dbg'].pinE = s.today + 30));
    both((_, s) => (s.items['rig.sq.yaml'].pinE = s.today + 2));
    both((_, s) => {
      s.items['dp.doc'].pinS = s.today - 20;
      s.items['dp.doc'].pinE = s.today - 15;
    });
    both((_, s) => (s.settings.weekly = 12));
  });

  it('create, including first child and drafts', () => {
    const add = (n: object) => both((X, s) => X.addItem(s, n));
    add({ kind: 'item', title: 'T', parent: 'gw.fw', hours: 16 });
    add({ kind: 'item', title: 'Empty', parent: null, deadline: Port.dayOf('2026-12-01') });
    add({ kind: 'item', title: 'c1', parent: 'gw.hw.can', hours: 5 });
    add({ kind: 'ms', title: 'Gate', parent: 'gw.val', pinE: Port.dayOf('2026-11-20') });
    add({ kind: 'ms', title: 'Gate 2', parent: 'rig', deps: ['n2'] });
    add({ kind: 'ext', title: 'Far', pinS: Port.dayOf('2028-01-01'), pinE: Port.dayOf('2028-01-10') });
  });

  it('move, delete', () => {
    both((X, s) => X.moveItem(s, 'gw.fw.pr.ota', 'rig'));
    both((X, s) => X.moveItem(s, 'gw.val', 'gw', 'gw.hw'));
    both((X, s) => X.moveItem(s, 'gw.fw', 'gw', null));
    both((X, s) => X.moveItem(s, 'gw.fw', null));
    both((X, s) => X.moveItem(s, 'dp.back', 'dp.doc'));
    both((X, s) => X.moveItem(s, 'dp.back', 'dp'));
    both((X, s) => X.removeItem(s, 'gw.fw.pr'));
    both((X, s) => X.removeItem(s, 'x.bench'));
    both((X, s) => X.removeItem(s, 'rig'));
  });

  it('Update plan at every reach', () => {
    both((_, s) => (s.items['gw.fw.pr.ota'].left = 80));
    both((X, s) => X.updatePlan(s, X.analyze(s), X.analyze(s).K['gw.fw'], true));
    both((_, s) => (s.items['rig.sq.ui'].left = 60));
    both((X, s) => X.updatePlan(s, X.analyze(s), ['rig.sq'], false));
    both((X, s) => X.updatePlan(s, X.analyze(s), ['rig'], true));
    both((X, s) => X.updatePlan(s, X.analyze(s), X.analyze(s).K[''], true));
  });
});
