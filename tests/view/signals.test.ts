import { beforeEach, describe, expect, it } from 'vitest';
import { analyze, type State } from '../../src/engine';
import { Signals } from '../../src/view/signals';
import { D, external, state, task } from '../engine/helpers';

const seed = (): State =>
  state(
    {
      p: task('p', 0, { deadline: D('2026-11-04') }),
      done: task('done', 0, { parent: 'p', est: 10, spent: 15 }),
      m: task('m', 12, { parent: 'p' }),
      c: task('c', 12, { parent: 'p', scope: 'could' }),
      x: external('x', '2026-11-02', '2026-11-02'),
      a: task('a', 6, { deps: ['x'] }),
    },
    [['m', 'c', 'a']],
  );

describe('signals', () => {
  let s: Signals;
  let st: State;
  beforeEach(() => {
    s = new Signals();
    st = seed();
  });

  it('runs nothing until a panel asks', () => {
    analyze(st);
    expect(s.runs).toBe(0);
  });

  it('asking again, or after a recalculation of the same inputs, reruns nothing', () => {
    const first = s.mvp(st, analyze(st), 'p');
    expect(s.runs).toBe(1);
    expect(s.mvp(st, analyze(st), 'p')).toBe(first);
    expect(s.runs).toBe(1);
  });

  it('a changed input reruns', () => {
    s.mvp(st, analyze(st), 'p');
    st.items.m.left = 18;
    s.mvp(st, analyze(st), 'p');
    expect(s.runs).toBe(2);
  });

  it('going back to earlier inputs finds them', () => {
    s.mvp(st, analyze(st), 'p');
    st.items.m.left = 18;
    s.mvp(st, analyze(st), 'p');
    st.items.m.left = 12;
    s.mvp(st, analyze(st), 'p');
    expect(s.runs).toBe(2);
  });

  it('each signal and each item has its own entry', () => {
    const a = analyze(st);
    s.mvp(st, a, 'p');
    s.estimate(st, a, 'p');
    s.external(st, a, 'x');
    s.mvp(st, a, 'a');
    expect(s.runs).toBe(4);
  });

  it('a drag keeps the last result and runs nothing', () => {
    const before = s.mvp(st, analyze(st), 'p');
    st.items.m.left = 18;
    expect(s.mvp(st, analyze(st), 'p', true)).toBe(before);
    expect(s.runs).toBe(1);
  });

  it('estimate: ratio on finished tasks and the adjusted finish', () => {
    // 15 over 10. m and c go from 12h to 18h. a is in no project of theirs and keeps 6h.
    // 42h at 6h/day from Mon 2 Nov is 7 working days, so Tue 10 Nov.
    const e = s.estimate(st, analyze(st), 'p');
    expect(e?.ratio).toBe(1.5);
    expect(e?.finish).toBe(D('2026-11-10'));
  });

  it('estimate: null with nothing finished', () => {
    delete st.items.done;
    expect(s.estimate(st, analyze(st), 'p')).toBeNull();
  });
});
