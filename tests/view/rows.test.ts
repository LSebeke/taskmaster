import { describe, expect, it } from 'vitest';
import { analyze, type State } from '../../src/engine';
import { buildRows, hiddenList, rowWindow, rowView, vsPlan } from '../../src/view/rows';
import { defaultUi } from '../../src/view/ui-state';
import { D, external, state, task } from '../engine/helpers';

const tree = (): State =>
  state(
    {
      p: task('Project', 0, { deadline: undefined }),
      'p.a': task('A', 12, { parent: 'p' }),
      'p.b': task('B', 0, { parent: 'p' }),
      'p.b.c': task('C', 12, { parent: 'p.b' }),
      q: task('Other', 6),
      x: { ...external('Bench', '2026-12-01', '2026-12-04') },
      y: { ...external('Earlier', '2026-11-20', '2026-11-21') },
    },
    [['p.a', 'p.b.c', 'q']],
  );
const ids = (st: State, ui = defaultUi()) => buildRows(st, analyze(st), ui).map(r => (r.section ? '#ext' : r.id));

describe('rows', () => {
  it('lists the tree, then the external section sorted by start', () => {
    expect(ids(tree())).toEqual(['p', 'p.a', 'p.b', 'p.b.c', 'q', '#ext', 'y', 'x']);
  });

  it('collapse drops descendants but keeps the row', () => {
    expect(ids(tree(), { ...defaultUi(), collapsed: new Set(['p.b']) })).toContain('p.b');
    expect(ids(tree(), { ...defaultUi(), collapsed: new Set(['p.b']) })).not.toContain('p.b.c');
  });

  it('hiding drops the row and its subtree', () => {
    expect(ids(tree(), { ...defaultUi(), hidden: new Set(['p.b', 'y']) })).toEqual(['p', 'p.a', 'q', '#ext', 'x']);
  });

  it('focus shows children only, with only the externals referenced from inside', () => {
    const st = tree();
    st.items['p.a'].deps = ['x'];
    expect(ids(st, { ...defaultUi(), focus: 'p' })).toEqual(['p.a', 'p.b', 'p.b.c', '#ext', 'x']);
    expect(ids(st, { ...defaultUi(), focus: 'p.b' })).toEqual(['p.b.c']);
  });

  it('a dependency on an ancestor of the focus still brings its external in', () => {
    const st = tree();
    st.items['p'].deps = ['x'];
    expect(ids(st, { ...defaultUi(), focus: 'p.b' })).toEqual(['p.b.c', '#ext', 'x']);
  });

  it('drops the external section when the view hides it or it is empty', () => {
    const st = tree();
    const ui = defaultUi();
    expect(ids(st, { ...ui, show: { ...ui.show, ext: false } })).not.toContain('#ext');
    expect(ids(st, { ...ui, hidden: new Set(['x', 'y']) })).not.toContain('#ext');
  });

  it('windows around the scroll position, clamped to the row count', () => {
    expect(rowWindow(0, 300, 1000)).toEqual([0, 12]);
    expect(rowWindow(3000, 300, 1000)).toEqual([98, 112]);
    expect(rowWindow(29900, 300, 1000)).toEqual([994, 1000]);
    expect(rowWindow(0, 300, 3)).toEqual([0, 3]);
  });

  it('lists every hidden row, even under a collapsed parent or outside the focus', () => {
    const st = tree();
    const list = hiddenList(st, new Set(['p.b.c', 'q', 'gone']));
    expect(list).toEqual([
      { id: 'p.b.c', title: 'C', path: 'Project › B' },
      { id: 'q', title: 'Other', path: '' },
    ]);
  });
});

describe('vs plan marker', () => {
  const marker = (st: State, id: string) => vsPlan(st, analyze(st), id);
  const planned = (end: string) => ({ start: D('2026-11-02'), end: D(end), hours: 12 });

  it('on plan', () => {
    const st = state({ a: task('a', 12) }, [['a']]);
    st.plan.a = planned('2026-11-03');
    expect(marker(st, 'a')).toMatchObject({ text: '✓ 0d', tone: 'good' });
  });

  it('behind', () => {
    const st = state({ a: task('a', 30) }, [['a']]);
    st.plan.a = planned('2026-11-03');
    expect(marker(st, 'a')).toMatchObject({ text: '▲ +3d', tone: 'crit' });
  });

  it('ahead', () => {
    const st = state({ a: task('a', 12) }, [['a']]);
    st.plan.a = planned('2026-11-05');
    expect(marker(st, 'a')).toMatchObject({ text: '▼ -2d', tone: 'good' });
  });

  it('past deadline takes precedence', () => {
    const st = state({ a: task('a', 60, { deadline: D('2026-11-04') }) }, [['a']]);
    st.plan.a = planned('2026-11-03');
    expect(marker(st, 'a')).toMatchObject({ text: '▲ 7d', tone: 'crit' });
  });

  it('a parent of drafts only is no new work: Update plan has no dates for it', () => {
    const st = state({ p: task('p', 0), d: task('d', 0, { parent: 'p', est: 0 }) }, []);
    expect(marker(st, 'p').text).toBe('○ no hrs');
  });

  it('done, new, draft', () => {
    const st = state({ a: task('a', 0, { spent: 5, est: 5, doneOn: D('2026-10-30') }), b: task('b', 6), c: task('c', 0, { est: 0 }) }, [['b']]);
    st.plan.a = { start: D('2026-10-28'), end: D('2026-10-30'), hours: 5 };
    expect(marker(st, 'a').text).toBe('✓ done');
    expect(marker(st, 'b').text).toBe('● new');
    expect(marker(st, 'c').text).toBe('○ no hrs');
  });

  it('external rows say ext, then past: never draft or new', () => {
    const st = state({ x: external('x', '2026-12-01', '2026-12-04'), y: external('y', '2026-10-01', '2026-10-04') }, []);
    expect(marker(st, 'x').text).toBe('ext');
    expect(marker(st, 'y').text).toBe('past');
  });
});

describe('row view', () => {
  it('leaves Done blank for milestones and externals, flags conflicts, and marks parents', () => {
    const st = state(
      {
        p: task('p', 0),
        a: task('a', 60, { parent: 'p', spent: 20, pinE: D('2026-11-03') }),
        m: { title: 'm', parent: 'p', kind: 'ms', deps: [] },
        x: external('x', '2026-12-01', '2026-12-04'),
      },
      [['a']],
    );
    const a = analyze(st);
    const conflicts = new Set(a.conflicts.map(c => c.id));
    const view = (id: string) => rowView(st, a, { id, depth: 0 }, conflicts, defaultUi());
    expect(view('p')).toMatchObject({ group: true, done: '25%', glyph: null, collapsed: false });
    expect(view('a')).toMatchObject({ group: false, conflict: true, done: '25%' });
    expect(view('m')).toMatchObject({ glyph: '◆', done: '' });
    expect(view('x')).toMatchObject({ glyph: '⛭', done: '' });
  });
});
