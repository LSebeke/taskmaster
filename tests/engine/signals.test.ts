import { describe, expect, it } from 'vitest';
import { analyze, externalImpact, mvp, mvpVerdict, nextUp, type MvpSignal, type State } from '../../src/engine';
import { D, external, state, task } from './helpers';

const signal = (deadline: string | undefined, full: string | null, noCould: string | null, mustOnly: string | null): MvpSignal => ({
  deadline: deadline ? D(deadline) : undefined,
  full: full ? D(full) : null,
  noCould: noCould ? D(noCould) : null,
  noCouldH: 0,
  mustOnly: mustOnly ? D(mustOnly) : null,
  mustOnlyH: 0,
});

describe('MVP verdict', () => {
  // m, s and c, 12h each, tied: 36h at 6h/day ends Mon 9 Nov, 24h ends Thu 5 Nov, 12h ends Tue 3 Nov.
  const project = (deadline: string): State =>
    state(
      {
        p: task('p', 0, { deadline: D(deadline) }),
        m: task('m', 12, { parent: 'p', scope: 'must' }),
        s: task('s', 12, { parent: 'p', scope: 'should' }),
        c: task('c', 12, { parent: 'p', scope: 'could' }),
      },
      [['m', 's', 'c']],
    );

  it('full scope makes it, on the very day', () => {
    expect(mvpVerdict(mvp(project('2026-11-09'), 'p'))).toBe('full');
  });

  it('drop could-haves', () => {
    expect(mvpVerdict(mvp(project('2026-11-06'), 'p'))).toBe('no-could');
  });

  it('MVP mode', () => {
    expect(mvpVerdict(mvp(project('2026-11-03'), 'p'))).toBe('must-only');
  });

  it('even must-haves miss', () => {
    expect(mvpVerdict(mvp(project('2026-11-02'), 'p'))).toBe('miss');
  });

  it('no deadline, or nothing scheduled: no signal', () => {
    expect(mvpVerdict(signal(undefined, '2026-11-09', null, null))).toBeNull();
    expect(mvpVerdict(signal('2026-11-09', null, null, null))).toBeNull();
  });

  it('never finishing does not make it', () => {
    expect(mvpVerdict({ ...signal('2026-11-09', null, '2026-11-20', '2026-11-05'), full: Infinity })).toBe('must-only');
  });

  it('an option that leaves nothing to do makes it', () => {
    const st = state({ p: task('p', 0, { deadline: D('2026-11-02') }), c: task('c', 60, { parent: 'p', scope: 'could' }) }, [['c']]);
    const m = mvp(st, 'p');
    expect(m.noCould).toBeNull();
    expect(mvpVerdict(m)).toBe('no-could');
  });
});

describe('next up', () => {
  const titles = (st: State, scope: string | null = null) => nextUp(st, analyze(st), scope).map(id => st.items[id].title);

  it('tier order, limit 5', () => {
    const st = state(Object.fromEntries('abcdefg'.split('').map(x => [x, task(x, 6)])), [['a'], ['b', 'c'], ['d', 'e', 'f', 'g']]);
    expect(titles(st)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('leaves out blocked and finished tasks', () => {
    const st = state({ a: task('a', 12), b: task('b', 6, { deps: ['a'] }), c: task('c', 0, { spent: 3 }), d: task('d', 6) }, [['a', 'b', 'c', 'd']]);
    expect(titles(st)).toEqual(['a', 'd']);
  });

  it('critical first inside a level, levels stay in order', () => {
    // Chains are per project. In p, c runs to the end and d, 1h, is off the chain.
    const st = state({ a: task('a', 6), p: task('p', 0), d: task('d', 1, { parent: 'p' }), c: task('c', 60, { parent: 'p' }) }, [['a'], ['d', 'c']]);
    const { results: by } = analyze(st);
    expect(by.c.crit).toBe(true);
    expect(by.d.crit).toBe(false);
    expect(titles(st)).toEqual(['a', 'c', 'd']);
  });

  it("an ancestor's dependency blocks", () => {
    const st = state({ a: task('a', 12), p: task('p', 0, { deps: ['a'] }), b: task('b', 6, { parent: 'p' }) }, [['a', 'b']]);
    expect(titles(st)).toEqual(['a']);
  });

  it('a dependency on a parent means all its tasks', () => {
    const st = state({ p: task('p', 0), a: task('a', 0, { parent: 'p', spent: 2 }), b: task('b', 6, { parent: 'p' }), c: task('c', 6, { deps: ['p'] }) }, [['b', 'c']]);
    expect(titles(st)).toEqual(['b']);
  });

  it('an external item blocks until it has passed', () => {
    const open = state({ x: external('x', '2026-11-02', '2026-11-04'), a: task('a', 6, { deps: ['x'] }) }, [['a']]);
    expect(titles(open)).toEqual([]);
    const passed = state({ x: external('x', '2026-10-01', '2026-10-02'), a: task('a', 6, { deps: ['x'] }) }, [['a']]);
    expect(titles(passed)).toEqual(['a']);
  });

  it('a dependency on a draft blocks nothing', () => {
    const st = state({ d: task('d', 0, { est: 0 }), a: task('a', 6, { deps: ['d'] }) }, [['a']]);
    expect(titles(st)).toEqual(['a']);
  });

  it('scope limits it to what is inside', () => {
    const st = state({ p: task('p', 0), a: task('a', 6, { parent: 'p' }), b: task('b', 6) }, [['b', 'a']]);
    expect(titles(st, 'p')).toEqual(['a']);
  });

  it('tolerates a level holding an id with no item', () => {
    const st = state({ a: task('a', 6) }, [['gone', 'a']]);
    expect(titles(st)).toEqual(['a']);
  });
});

describe('stale', () => {
  it('counts from the start when hours left were never updated', () => {
    const st = state({ a: task('a', 6, { actualStart: D('2026-10-20') }) }, [['a']]);
    expect(analyze(st).results.a.stale).toBe(13);
  });

  it('follows the setting', () => {
    const st = state({ a: task('a', 6, { actualStart: D('2026-10-01'), touched: D('2026-10-31') }) }, [['a']]);
    st.settings.staleDays = 2;
    expect(analyze(st).results.a.stale).toBe(2);
  });

  it('a task not started is not stale', () => {
    const st = state({ a: task('a', 6, { touched: D('2026-10-01') }) }, [['a']]);
    expect(analyze(st).results.a.stale).toBeUndefined();
  });
});

describe('external effect', () => {
  it('a blocked start can slip while the project finish stays put', () => {
    // a 6h waits for the outage on 2 Nov, b 30h does not. 36h at 6h/day takes 2 to 9 Nov either way.
    const st = state(
      {
        x: external('x', '2026-11-02', '2026-11-02'),
        p: task('p', 0),
        a: task('a', 6, { parent: 'p', deps: ['x'] }),
        b: task('b', 30, { parent: 'p' }),
      },
      [['a', 'b']],
    );
    const fx = externalImpact(st, 'x');
    expect(fx.items).toEqual([{ id: 'a', start: D('2026-11-03'), days: 1 }]);
    expect(fx.projects).toEqual([{ root: 'p', days: 0 }]);
  });

  it('a project with nothing blocked counts when delayed work takes its hours', () => {
    // a 12h outranks q 12h, whose start is pinned to Thu 5 Nov. Free of the outage, a runs Mon and Tue and q Thu and Fri.
    // The outage ends Wed 4 Nov, so a takes Thu and Fri, and q moves to Mon 9 and Tue 10 Nov: 2 working days later.
    const st = state({ x: external('x', '2026-11-02', '2026-11-04'), a: task('a', 12, { deps: ['x'] }), q: task('q', 12, { pinS: D('2026-11-05') }) }, [['a'], ['q']]);
    expect(externalImpact(st, 'x').projects).toEqual([
      { root: 'a', days: 3 },
      { root: 'q', days: 2 },
    ]);
  });

  it('a project it does not touch stays off the list', () => {
    const st = state({ x: external('x', '2026-11-02', '2026-11-02'), a: task('a', 6, { deps: ['x'] }), q: task('q', 6) }, [['a'], ['q']]);
    expect(externalImpact(st, 'x').projects.map(p => p.root)).toEqual(['a']);
  });

  it('a lone blocked task slips both, in working days across a weekend', () => {
    // Ends Fri 6 Nov, so a starts Mon 9 Nov: 5 working days after Mon 2 Nov.
    const st = state({ x: external('x', '2026-11-02', '2026-11-06'), a: task('a', 12, { deps: ['x'] }) }, [['a']]);
    const fx = externalImpact(st, 'x');
    expect(fx.items).toEqual([{ id: 'a', start: D('2026-11-09'), days: 5 }]);
    expect(fx.projects).toEqual([{ root: 'a', days: 5 }]);
  });
});
