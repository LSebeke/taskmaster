import { describe, expect, it } from 'vitest';
import { addTier, analyze, editLog, ensureTiers, addLog, moveToTier, removeTier, setTotal } from '../../src/engine';
import { state, task } from './helpers';

describe('acceptance: priority levels', () => {
  it('move c to level 0: emptied level stays', () => {
    expect(moveToTier([['a', 'b'], ['c']], 'c', 0)).toEqual([['a', 'b', 'c'], []]);
  });

  it('move c to level 0 before b', () => {
    expect(moveToTier([['a', 'b'], ['c']], 'c', 0, 'b')).toEqual([['a', 'c', 'b'], []]);
  });

  it('adds a level where asked', () => {
    expect(addTier([['a']], 0)).toEqual([[], ['a']]);
  });

  it('refuses to remove a non-empty level, removes an empty one', () => {
    expect(removeTier([['a'], []], 0)).toEqual([['a'], []]);
    expect(removeTier([['a'], []], 1)).toEqual([['a']]);
  });
});

describe('ensureTiers', () => {
  it('puts unlisted tasks in the last level, not milestones, drafts or external items', () => {
    const st = state(
      {
        p: task('p', 0),
        a: task('a', 5, { parent: 'p' }),
        b: task('b', 5),
        draft: task('draft', 0),
        m: { title: 'm', parent: 'p', kind: 'ms' },
        x: { title: 'x', parent: null, kind: 'ext', pinS: 1, pinE: 2 },
      },
      [['b'], []],
    );
    ensureTiers(st);
    expect(st.tiers).toEqual([['b'], ['a']]);
  });

  it('creates a level when there are none', () => {
    const st = state({ a: task('a', 5) }, []);
    ensureTiers(st);
    expect(st.tiers).toEqual([['a']]);
  });

  it('spec: a finished task raised again returns to the last level', () => {
    const st = state({ a: task('a', 4, { spent: 2 }), b: task('b', 4) }, [['a'], ['b']]);
    setTotal(st.items.a, 1, st.today);
    ensureTiers(st);
    expect(st.tiers).toEqual([[], ['b']]);
    setTotal(st.items.a, 10, st.today);
    ensureTiers(st);
    expect(st.tiers).toEqual([[], ['b', 'a']]);
  });
});

describe('acceptance: hours', () => {
  const blocked = () =>
    state({ a: task('a', 24), b: task('b', 12, { deps: ['a'] }) }, [['a'], ['b']]);

  it('log, edit, delete on unstarted b', () => {
    const st = blocked();
    const b = st.items.b;
    const start = analyze(st).results.b.start;

    addLog(b, st.today, 3, st.today);
    expect(analyze(st).results.b.start).toBe(start);
    expect(b.actualStart).toBeUndefined();
    expect([b.spent, b.left]).toEqual([3, 9]);

    editLog(b, 0, 1, st.today);
    expect([b.spent, b.left]).toEqual([1, 11]);

    editLog(b, 0, 0, st.today);
    expect([b.spent, b.left]).toEqual([0, 12]);
    expect(b.log).toEqual([]);
  });

  it('two logs on one day merge', () => {
    const st = blocked();
    addLog(st.items.a, st.today, 1, st.today);
    addLog(st.items.a, st.today, 2, st.today);
    expect(st.items.a.log).toEqual([{ d: st.today, h: 3 }]);
  });

  it('spent 2, set total 20: left 18', () => {
    const it = task('b', 10, { spent: 2 });
    setTotal(it, 20, 100);
    expect(it.left).toBe(18);
  });

  it('spent 2, set total 1: left 0, done. Set total 10: left 8, reopened', () => {
    const it = task('b', 10, { spent: 2 });
    setTotal(it, 1, 100);
    expect(it.left).toBe(0);
    expect(it.doneOn).toBe(100);
    setTotal(it, 10, 101);
    expect(it.left).toBe(8);
    expect(it.doneOn).toBeNull();
  });
});
