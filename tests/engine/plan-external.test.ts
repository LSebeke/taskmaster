import { describe, expect, it } from 'vitest';
import {
  accuracy,
  addItem,
  adjusted,
  analyze,
  effDeps,
  externalImpact,
  kids,
  mvp,
  snapshot,
  updatePlan,
  type State,
} from '../../src/engine';
import { D, day, external, state, task } from './helpers';

describe('acceptance: external items', () => {
  const mk = (end = '2026-11-04', start = '2026-11-02') =>
    state({ x: external('x', start, end), a: task('a', 12, { deps: ['x'] }), b: task('b', 6) }, [['a', 'b']]);

  it('a 12h depends on external 2 to 4 Nov: a starts Thu 5 Nov, capacity unchanged', () => {
    const { by } = analyze(mk());
    expect(day(by.a.start)).toBe('2026-11-05');
    expect(day(by.b.end)).toBe('2026-11-02'); // b has the whole 6h during the outage
  });

  it('same, external end moved to Mon 9 Nov: a starts Tue 10 Nov, no plan entry changes', () => {
    const st = mk('2026-11-09');
    expect(day(analyze(st).by.a.start)).toBe('2026-11-10');
    expect(st.plan).toEqual({});
  });

  it('external end before today: no delay, finished', () => {
    const { by } = analyze(mk('2026-10-05', '2026-10-01'));
    expect(day(by.a.start)).toBe('2026-11-02');
    expect(by.x.done).toBe(true);
  });

  it('external end on a weekend: dependents start the next working day', () => {
    expect(day(analyze(mk('2026-11-07')).by.a.start)).toBe('2026-11-09');
  });

  it('external with no dependents, dated after a project end: finish unchanged, no capacity used', () => {
    const st = state({ p: task('p', 0), a: task('a', 12, { parent: 'p' }) }, [['a']]);
    const end = analyze(st).by.p.end;
    addItem(st, { kind: 'ext', title: 'Far', pinS: D('2028-01-01'), pinE: D('2028-01-10') });
    expect(analyze(st).by.p.end).toBe(end);
  });

  it.each(['2026-11-03', '2026-11-04'])('task pinned to start %s inside it: start stays, conflict', pin => {
    const st = mk();
    st.items.a.pinS = D(pin);
    const r = analyze(st);
    expect(day(r.by.a.start)).toBe(pin);
    expect(r.conflicts.some(c => c.id === 'a')).toBe(true);
  });

  it('same, pinned to the day after it ends: no conflict', () => {
    const st = mk();
    st.items.a.pinS = D('2026-11-05');
    expect(analyze(st).conflicts.some(c => c.id === 'a')).toBe(false);
  });

  it('a dependency on a parent reaches its tasks', () => {
    const st = state(
      { x: external('x', '2026-11-02', '2026-11-04'), p: task('p', 0, { deps: ['x'] }), a: task('a', 6, { parent: 'p' }) },
      [['a']],
    );
    expect(effDeps(st, 'a', kids(st))).toContain('x');
    expect(day(analyze(st).by.a.start)).toBe('2026-11-05');
  });

  it('an unfinished external item can sit on the critical chain', () => {
    const st = state({ x: external('x', '2026-11-02', '2026-11-04'), a: task('a', 12, { deps: ['x'] }) }, [['a']]);
    const r = analyze(st);
    expect(r.links).toEqual([{ a: 'x', b: 'a', kind: 'dep' }]);
    expect(r.by.x.crit).toBe(true);
  });

  it('a finished one cannot', () => {
    const st = state({ x: external('x', '2026-10-01', '2026-10-05'), a: task('a', 12, { deps: ['x'] }) }, [['a']]);
    expect(analyze(st).links).toEqual([]);
  });

  it('effect compares blocked starts with a schedule excluding the item, and project finish', () => {
    // Without x, a starts 2 Nov. With x, 5 Nov. 48h total either way.
    const st = state(
      {
        x: external('x', '2026-11-02', '2026-11-04'),
        p: task('p', 0),
        a: task('a', 6, { parent: 'p', deps: ['x'] }),
        long: task('long', 42, { parent: 'p' }),
      },
      [['a', 'long']],
    );
    const fx = externalImpact(st, 'x');
    expect(fx.users).toEqual(['a']);
    expect(fx.items).toEqual([{ id: 'a', start: D('2026-11-05'), days: 3 }]);
    // Other work takes the hours: finish is the same with or without x.
    expect(fx.projects).toEqual([{ root: 'p', days: 0 }]);
  });
});

describe('acceptance: Update plan', () => {
  /** gw > fw > { x, y }, gw > hw > z, all planned from a first analysis. */
  const planned = (): State => {
    const st = state(
      {
        gw: task('gw', 0),
        fw: task('fw', 0, { parent: 'gw' }),
        x: task('x', 12, { parent: 'fw' }),
        y: task('y', 12, { parent: 'fw' }),
        hw: task('hw', 0, { parent: 'gw' }),
        z: task('z', 6, { parent: 'hw' }),
        bench: external('bench', '2026-11-30', '2026-12-04'),
      },
      [['x', 'y', 'z']],
    );
    const a = analyze(st);
    updatePlan(st, a, ['gw'], true);
    return st;
  };
  const clone = <T>(x: T): T => structuredClone(x);

  it('at top level: external items unaffected', () => {
    const st = planned();
    const a = analyze(st);
    updatePlan(st, a, a.K['']!, true);
    expect(st.plan.bench).toBeUndefined();
  });

  it('plain forecast changes do not touch the plan', () => {
    const st = planned();
    const before = clone(st.plan);
    st.items.x.left = 80;
    analyze(st);
    expect(st.plan).toEqual(before);
  });

  it('on children of a parent, deep: parent and ancestors unchanged, parent reports plan gap', () => {
    const st = planned();
    const gw = clone(st.plan.gw);
    const fw = clone(st.plan.fw);
    st.items.x.left = 80;
    const a = analyze(st);
    updatePlan(st, a, a.K.fw!, true);
    expect(st.plan.gw).toEqual(gw);
    expect(st.plan.fw).toEqual(fw);
    expect(st.plan.x!.hours).toBe(80);
    const after = analyze(st);
    expect(after.by.fw.planGap).toBeGreaterThan(0);
    expect(after.by.fw.planGapH).toBe(68);
  });

  it('with a nested parent selected, deep: it and its subtree change, ancestors unchanged', () => {
    const st = planned();
    const gw = clone(st.plan.gw);
    const hw = clone(st.plan.hw);
    st.items.x.left = 80;
    const a = analyze(st);
    updatePlan(st, a, ['fw'], true);
    expect(st.plan.gw).toEqual(gw);
    expect(st.plan.hw).toEqual(hw);
    expect(st.plan.fw!.hours).toBe(92);
    expect(st.plan.x!.hours).toBe(80);
  });

  it('not deep: sub-levels stay', () => {
    const st = planned();
    const x = clone(st.plan.x);
    st.items.x.left = 80;
    updatePlan(st, analyze(st), ['fw'], false);
    expect(st.plan.x).toEqual(x);
    expect(st.plan.fw!.hours).toBe(92);
  });

  it('every update appends to history with prior values', () => {
    const st = planned();
    const x = clone(st.plan.x);
    updatePlan(st, analyze(st), ['x'], true);
    expect(st.planHistory!.at(-1)).toEqual({ day: st.today, ids: ['x'], before: { x } });
    expect(st.planHistory).toHaveLength(2);
  });

  it('new items stay out of the plan until updated', () => {
    const st = planned();
    const id = addItem(st, { kind: 'item', title: 'New', parent: 'fw', hours: 6 });
    expect(st.plan[id]).toBeUndefined();
    expect(analyze(st).by[id].shift).toBeUndefined();
  });
});

describe('metrics', () => {
  it('snapshot takes spent + left and rollup dates', () => {
    const st = state({ a: task('a', 12, { spent: 3 }) }, [['a']]);
    expect(snapshot(analyze(st), st, 'a')).toEqual({ start: D('2026-11-02'), end: D('2026-11-03'), hours: 15 });
  });

  it('done %, vs plan and past deadline, in working days', () => {
    const st = state(
      { a: task('a', 18, { spent: 6, deadline: D('2026-11-03') }) },
      [['a']],
    );
    st.plan.a = { start: D('2026-11-02'), end: D('2026-11-02'), hours: 24 };
    const { by } = analyze(st);
    expect(by.a.pct).toBe(0.25);
    expect(day(by.a.end)).toBe('2026-11-04');
    expect(by.a.shift).toBe(2);
    expect(by.a.overDeadline).toBe(1);
  });

  it('plan says today: hours-weighted share of the window elapsed, in working days', () => {
    const st = state({ p: task('p', 0), a: task('a', 5, { parent: 'p' }), b: task('b', 5, { parent: 'p' }) }, [['a', 'b']]);
    st.today = D('2026-11-04'); // Wed: Mon and Tue elapsed
    st.plan.a = { start: D('2026-11-02'), end: D('2026-11-06'), hours: 30 }; // 2 of 5
    st.plan.b = { start: D('2026-11-09'), end: D('2026-11-13'), hours: 10 }; // not begun
    expect(analyze(st).by.p.shouldPct).toBeCloseTo((30 * 0.4) / 40);
  });

  it('stale: in-progress task with hours left not updated for 7 days', () => {
    const st = state(
      {
        a: task('a', 6, { actualStart: D('2026-10-01'), touched: D('2026-10-26') }),
        b: task('b', 6, { actualStart: D('2026-10-01'), touched: D('2026-10-27') }),
      },
      [['a', 'b']],
    );
    const { by } = analyze(st);
    expect(by.a.stale).toBe(7);
    expect(by.b.stale).toBeUndefined();
  });

  it('estimate ratio over finished tasks, adjusted finish scales hours left', () => {
    const st = state(
      {
        p: task('p', 0),
        done: task('done', 0, { parent: 'p', est: 10, spent: 15 }),
        open: task('open', 12, { parent: 'p' }),
      },
      [['open']],
    );
    expect(accuracy(st, 'p')).toEqual({ ratio: 1.5, sample: 10 });
    expect(day(adjusted(st, 'p', 1.5))).toBe('2026-11-04'); // 18h at 6h/day
  });

  it('accuracy is null with nothing finished', () => {
    const st = state({ a: task('a', 6) }, [['a']]);
    expect(accuracy(st, 'a')).toBeNull();
  });

  it('MVP: finish dates and hours saved per option', () => {
    const st = state(
      {
        p: task('p', 0, { deadline: D('2026-11-04') }),
        m: task('m', 12, { parent: 'p', scope: 'must' }),
        s: task('s', 12, { parent: 'p', scope: 'should' }),
        c: task('c', 12, { parent: 'p', scope: 'could' }),
      },
      [['m', 's', 'c']],
    );
    const r = mvp(st, 'p');
    expect(r.deadline).toBe(D('2026-11-04'));
    expect(day(r.full)).toBe('2026-11-09'); // 36h at 6h/day: 6 working days
    expect(day(r.noCould)).toBe('2026-11-05');
    expect(r.noCouldH).toBe(12);
    expect(day(r.mustOnly)).toBe('2026-11-03');
    expect(r.mustOnlyH).toBe(24);
  });
});
