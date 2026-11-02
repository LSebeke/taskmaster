import { describe, expect, it } from 'vitest';
import {
  addItem,
  newItemError,
  analyze,
  depBlocker,
  ensureTiers,
  hasCycle,
  kids,
  mvp,
  moveError,
  moveItem,
  placeError,
  removeItem,
  setTotal,
  validateNew,
} from '../../src/engine';
import { D, day, external, state, task } from './helpers';

const item = { kind: 'item' as const };

describe('acceptance: creating', () => {
  it('create item with no hours: draft, listed, not scheduled, not done, no MVP signal', () => {
    const st = state({ a: task('a', 12) }, [['a']]);
    const id = addItem(st, { ...item, title: 'Empty', deadline: D('2026-12-01') });
    const r = analyze(st);
    expect(r.by[id]).toMatchObject({ done: false, draft: true, end: null });
    expect(r.K['']).toContain(id);
    expect(mvp(st, id).full).toBeNull();
  });

  it('hours on a draft schedule it', () => {
    const st = state({}, [[]]);
    const id = addItem(st, { ...item, title: 'Empty' });
    setTotal(st.items[id], 6, st.today);
    ensureTiers(st);
    const r = analyze(st);
    expect(day(r.by[id].end)).toBe('2026-11-02');
    expect(r.by[id].draft).toBeUndefined();
    expect(st.tiers.flat()).toContain(id);
  });

  it('create milestone with no parent: refused', () => {
    expect(validateNew({ kind: 'ms', title: 'x' })).toBeTruthy();
  });

  it('name is required, hours are optional', () => {
    expect(validateNew({ ...item, title: ' ' })).toBeTruthy();
    expect(validateNew({ ...item, title: 'P' })).toBeNull();
  });

  it('external items need both dates in order', () => {
    expect(validateNew({ kind: 'ext', title: 'x' })).toBeTruthy();
    expect(validateNew({ kind: 'ext', title: 'x', pinS: 5, pinE: 3 })).toBeTruthy();
    expect(validateNew({ kind: 'ext', title: 'x', pinS: 3, pinE: 3 })).toBeNull();
  });

  it('create item, no level given: joins last level, forecast changes, no plan changes', () => {
    const st = state({ a: task('a', 12) }, [['a'], []]);
    st.plan.a = { start: st.today, end: st.today + 1, hours: 12 };
    const before = structuredClone(st.plan);
    const left = analyze(st).by.a.left;
    const id = addItem(st, { ...item, title: 'T', hours: 16 });
    expect(st.tiers).toEqual([['a'], [id]]);
    expect(st.plan).toEqual(before);
    const r = analyze(st);
    expect(day(r.by[id].end)).toBe('2026-11-06'); // 28h at 6h/day: 5 working days
    expect(r.by.a.left).toBe(left);
  });

  it('dependency on a draft is ignored; dependent is scheduled', () => {
    const st = state({}, [[]]);
    const draft = addItem(st, { ...item, title: 'Empty' });
    const a = addItem(st, { ...item, title: 'A', hours: 6, deps: [draft] });
    expect(day(analyze(st).by[a].end)).toBe('2026-11-02');
  });

  it('a milestone depending only on drafts lands on today', () => {
    const st = state({ p: task('p', 0), kid: task('kid', 6, { parent: 'p' }) }, [['kid']]);
    const draft = addItem(st, { ...item, title: 'Empty' });
    const m = addItem(st, { kind: 'ms', title: 'M', parent: 'p', deps: [draft] });
    expect(day(analyze(st).by[m].end)).toBe('2026-11-02');
  });
});

describe('milestones', () => {
  const withKid = () => state({ p: task('p', 0), a: task('a', 12, { parent: 'p' }) }, [['a']]);

  it('date is when its dependencies finish', () => {
    const st = withKid();
    const m = addItem(st, { kind: 'ms', title: 'M', parent: 'p', deps: ['a'] });
    expect(day(analyze(st).by[m].end)).toBe('2026-11-03');
  });

  it('date is its pin, done once that date has passed', () => {
    const st = withKid();
    const m = addItem(st, { kind: 'ms', title: 'M', parent: 'p', pinE: D('2026-10-30') });
    const r = analyze(st);
    expect(day(r.by[m].end)).toBe('2026-10-30');
    expect(r.by[m].done).toBe(true);
    st.items[m].pinE = D('2026-11-09');
    expect(analyze(st).by[m].done).toBe(false);
  });

  it('spec: dependencies finished in the past keep the milestone date there', () => {
    const st = withKid();
    st.items.a = task('a', 0, { parent: 'p', spent: 12, doneOn: D('2026-10-28') });
    const m = addItem(st, { kind: 'ms', title: 'M', parent: 'p', deps: ['a'] });
    const r = analyze(st);
    expect(day(r.by[m].end)).toBe('2026-10-28');
    expect(r.by[m].done).toBe(true);
  });

  it('a milestone waiting on a milestone settles the same day, even with capacity used up', () => {
    const st = state({ p: task('p', 0), a: task('a', 6, { parent: 'p' }) }, [['a']]);
    const m2Id = 'm2';
    st.items[m2Id] = { title: 'm2', parent: 'p', kind: 'ms', deps: ['m1'] };
    st.items.m1 = { title: 'm1', parent: 'p', kind: 'ms', deps: ['a'] };
    const r = analyze(st);
    expect(day(r.by.m1.end)).toBe('2026-11-02');
    expect(day(r.by.m2.end)).toBe('2026-11-02');
  });

  it('spec: a pin before a dependency finishes is a conflict and the pin stays', () => {
    const st = withKid();
    const m = addItem(st, { kind: 'ms', title: 'M', parent: 'p', deps: ['a'], pinE: D('2026-11-02') });
    const r = analyze(st);
    expect(day(r.by[m].end)).toBe('2026-11-02');
    expect(r.conflicts.some(c => c.id === m)).toBe(true);
  });
});

describe('acceptance: first child and last child', () => {
  const setup = () => {
    const st = state(
      {
        x: task('x', 12),
        t: task('t', 14, { spent: 2, deps: ['x'], pinE: D('2026-12-01') }),
      },
      [['x'], ['t'], ['other']],
    );
    return st;
  };

  it('task 16h, 2h logged, dep on x, gets first child: budget 16, left 0, spent 2, child waits and takes its level', () => {
    const st = setup();
    const c = addItem(st, { ...item, title: 'c', parent: 't', hours: 6 });
    const t = st.items.t;
    expect(t.budget).toBe(16);
    expect(t.left).toBe(0);
    expect(t.pinE).toBeUndefined();
    expect(t.deps).toEqual(['x']);
    const r = analyze(st);
    expect(r.by.t.spent).toBe(2);
    expect(r.by.t.left).toBe(6);
    expect(day(r.by[c].start)).toBe('2026-11-04'); // x takes 2 and 3 Nov
    ensureTiers(st);
    expect(st.tiers[1]).toEqual([c]);
  });

  it('keeps an existing budget', () => {
    const st = setup();
    st.items.t.budget = 40;
    addItem(st, { ...item, title: 'c', parent: 't', hours: 6 });
    expect(st.items.t.budget).toBe(40);
  });

  it('delete the last child: left = budget - spent, scheduled again in the last level', () => {
    const st = setup();
    const c = addItem(st, { ...item, title: 'c', parent: 't', hours: 6 });
    ensureTiers(st);
    removeItem(st, c);
    const t = st.items.t;
    expect(t.left).toBe(14);
    expect(t.budget).toBeUndefined();
    ensureTiers(st);
    expect(st.tiers.at(-1)).toContain('t');
    expect(analyze(st).by.t.end).not.toBeNull();
  });

  it('move the last child away: same', () => {
    const st = setup();
    const c = addItem(st, { ...item, title: 'c', parent: 't', hours: 6 });
    moveItem(st, c, null);
    expect(st.items.t.left).toBe(14);
    expect(st.items.t.budget).toBeUndefined();
  });

  it('budget equal to logged hours: nothing left, counts as done', () => {
    const st = state({ t: task('t', 0, { spent: 5 }) }, [[]]);
    const c = addItem(st, { ...item, title: 'c', parent: 't', hours: 6 });
    removeItem(st, c);
    expect(st.items.t.doneOn).toBe(st.today);
    expect(analyze(st).by.t.done).toBe(true);
  });
});

describe('acceptance: moving', () => {
  const tree = () => {
    const st = state(
      {
        p: task('p', 0, { budget: 50, deadline: D('2026-12-18') }),
        a: task('a', 10, { parent: 'p', pinS: D('2026-11-04') }),
        b: task('b', 20, { parent: 'p' }),
        q: task('q', 0, { budget: 30 }),
        c: task('c', 5, { parent: 'q' }),
      },
      [['a', 'b', 'c']],
    );
    st.plan.a = { start: st.today, end: st.today, hours: 10 };
    return st;
  };

  it('budgets, plans and pins stay, rollups change', () => {
    const st = tree();
    const leftQ = analyze(st).by.q.left;
    const plan = structuredClone(st.plan);
    moveItem(st, 'a', 'q');
    expect(st.items.a.pinS).toBe(D('2026-11-04'));
    expect(st.items.p.budget).toBe(50);
    expect(st.items.q.budget).toBe(30);
    expect(st.plan).toEqual(plan);
    expect(analyze(st).by.q.left).toBe(leftQ + 10);
  });

  it('sibling order is respected', () => {
    const st = tree();
    moveItem(st, 'b', 'p', 'a');
    expect(kids(st).p).toEqual(['b', 'a']);
    moveItem(st, 'b', 'p', null);
    expect(kids(st).p).toEqual(['a', 'b']);
  });

  it('into a task converts it; moving out returns the hours', () => {
    const st = tree();
    moveItem(st, 'a', 'c');
    expect(st.items.c).toMatchObject({ budget: 5, left: 0 });
    moveItem(st, 'a', 'p');
    expect(st.items.c.left).toBe(5);
    expect(st.items.c.budget).toBeUndefined();
  });

  it('refuses a move into itself or a descendant, with a message', () => {
    const st = tree();
    expect(moveError(st, 'p', 'a')).toMatch(/inside itself/);
    expect(moveError(st, 'a', 'a')).toMatch(/inside itself/);
  });

  it('refuses a move into a milestone, and a milestone to top level', () => {
    const st = tree();
    st.items.m = { title: 'm', parent: 'q', kind: 'ms' };
    expect(moveError(st, 'a', 'm')).toMatch(/Milestones/);
    expect(moveError(st, 'm', null)).toMatch(/needs a parent/);
  });

  it('refuses a move creating a dependency loop, leaving the tree as it was', () => {
    const st = state(
      {
        p: task('p', 0, { deps: ['b'] }),
        kid: task('kid', 1, { parent: 'p' }),
        a: task('a', 1),
        b: task('b', 1, { deps: ['a'] }),
      },
      [['kid', 'a', 'b']],
    );
    expect(moveError(st, 'a', 'p')).toMatch(/loop/);
    expect(st.items.a.parent).toBeNull();
    expect(hasCycle(st)).toBe(false);
  });

  it('allows legal moves, including to top level', () => {
    const st = tree();
    expect(moveError(st, 'a', 'q')).toBeNull();
    expect(moveError(st, 'a', null)).toBeNull();
  });
});

describe('acceptance: deleting', () => {
  it('delete a parent: subtree, plan entries, priority entries and dependencies on it all gone', () => {
    const st = state(
      {
        p: task('p', 0),
        a: task('a', 10, { parent: 'p' }),
        b: task('b', 20, { parent: 'p' }),
        c: task('c', 5, { deps: ['a', 'b'] }),
        d: task('d', 5, { deps: ['p'] }),
      },
      [['a', 'b'], ['c', 'd']],
    );
    st.plan.a = { start: 1, end: 2, hours: 10 };
    st.plan.c = { start: 1, end: 2, hours: 5 };
    expect(removeItem(st, 'p')).toBe(3);
    expect(Object.keys(st.items)).toEqual(['c', 'd']);
    expect(Object.keys(st.plan)).toEqual(['c']);
    expect(st.tiers).toEqual([[], ['c', 'd']]);
    expect(st.items.c.deps).toEqual([]);
    expect(st.items.d.deps).toEqual([]);
    analyze(st);
  });
});

describe('dependency picker', () => {
  it('blocks candidates that would create a cycle', () => {
    const st = state({ a: task('a', 1), b: task('b', 1, { deps: ['a'] }), c: task('c', 1, { deps: ['b'] }) }, [['a', 'b', 'c']]);
    const blocked = depBlocker(st, 'a');
    expect(blocked('b')).toBe(true);
    expect(blocked('c')).toBe(true);
    expect(depBlocker(st, 'c')('a')).toBe(false);
  });
});

describe('acceptance: external items, structure', () => {
  const st0 = () => state({ a: task('a', 6), x: external('x', '2026-11-02', '2026-11-04') }, [['a']]);

  it('move an external item, or move anything into one: refused', () => {
    const st = st0();
    expect(moveError(st, 'x', 'a')).toMatch(/External/);
    expect(moveError(st, 'a', 'x')).toMatch(/External/);
  });

  it('delete removes links to it', () => {
    const st = st0();
    st.items.a.deps = ['x'];
    removeItem(st, 'x');
    expect(st.items.a.deps).toEqual([]);
  });

  it('creating one uses no level and no plan', () => {
    const st = st0();
    const id = addItem(st, { kind: 'ext', title: 'Far', pinS: D('2028-01-01'), pinE: D('2028-01-10') });
    expect(st.tiers.flat()).not.toContain(id);
    expect(st.items[id].parent).toBeNull();
  });
});

describe('newItemError: what a new item may not do', () => {
  const base = () =>
    state(
      {
        p: task('P', 0),
        t: task('T', 12, { parent: 'p' }),
        u: task('U', 12, { parent: 'p', deps: ['t'] }),
        m: { title: 'M', parent: 'p', kind: 'ms', deps: [] },
        x: external('X', '2026-11-02', '2026-11-03'),
      },
      [['t', 'u']],
    );
  const fresh = { ...item, title: 'New' };

  it('passes a plain item, and leaves the state alone', () => {
    const st = base();
    const was = JSON.stringify(st);
    expect(newItemError(st, { ...fresh, parent: 'p', deps: ['t'] })).toBeNull();
    expect(JSON.stringify(st)).toBe(was);
  });
  it('refuses field errors', () => {
    expect(newItemError(base(), { ...fresh, title: ' ' })).toMatch(/name/i);
    expect(newItemError(base(), { kind: 'ms', title: 'M2' })).toMatch(/needs a parent/);
  });
  it('refuses a parent that cannot have children', () => {
    expect(newItemError(base(), { ...fresh, parent: 'm' })).toMatch(/Milestones cannot/);
    expect(newItemError(base(), { ...fresh, parent: 'x' })).toMatch(/External items cannot/);
    expect(newItemError(base(), { ...fresh, parent: 'gone' })).toMatch(/gone/);
  });
  it('refuses a loop through the new item: its parent is depended on by what it would wait for', () => {
    const st = base();
    st.items.v = task('V', 6, { deps: ['t'] });
    expect(newItemError(st, { ...fresh, parent: 't', deps: ['v'] })).toMatch(/loop/);
  });
  it('refuses end pin before start pin', () => {
    expect(newItemError(base(), { ...fresh, pinS: D('2026-11-05'), pinE: D('2026-11-02') })).toMatch(/before/);
  });
});

describe('addItem with a given id', () => {
  it('keys the item by it: notes are keyed by path', () => {
    const st = state({ p: task('P', 6) }, [['p']]);
    expect(addItem(st, { ...item, title: 'C', parent: 'p', hours: 3, id: 'Projects/P/C.md' })).toBe('Projects/P/C.md');
    expect(st.items['Projects/P/C.md'].parent).toBe('p');
    expect(st.tiers).toEqual([['p', 'Projects/P/C.md']]);
  });
});

describe('placeError with a parent the state no longer has', () => {
  it('does not walk off the tree', () => {
    const st = state({ a: task('a', 8) }, [['a']]);
    expect(placeError(st, 'a', 'gone')).toBeNull();
  });
});
