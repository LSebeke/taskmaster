import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/engine';
import { historyView, openPlan, planRows, planTarget, setPlanDeep, togglePlanRow } from '../../src/view/plan-ui';
import { defaultUi, escape, pruneUi } from '../../src/view/ui-state';
import { D, external, state, task } from '../engine/helpers';

const make = () =>
  state(
    {
      p: task('Gateway', 0),
      g: task('Firmware', 0, { parent: 'p' }),
      a: task('a', 12, { parent: 'g' }),
      b: task('b', 12, { parent: 'g' }),
      d: task('d', 0, { parent: 'p', est: 0 }),
      q: task('Rig', 8),
      x: external('Bench', '2026-12-01', '2026-12-02'),
    },
    [['a', 'b', 'q']],
  );
const st = make();
const a = analyze(st);

describe('what Update plan targets', () => {
  it('nothing selected: the rows at the current level, without externals', () => {
    expect(planTarget(st, a, defaultUi())).toEqual({ rows: ['p', 'q'], name: 'all projects', above: null });
  });

  it('a selected row', () => {
    expect(planTarget(st, a, { ...defaultUi(), sel: 'g' })).toEqual({ rows: ['g'], name: 'Firmware', above: 'p' });
  });

  it('focused: the rows inside, and the name says so, since the focused item itself stays', () => {
    expect(planTarget(st, a, { ...defaultUi(), focus: 'g' })).toEqual({ rows: ['a', 'b'], name: 'under Firmware', above: 'g' });
  });

  it('an external selected counts as nothing selected', () => {
    expect(planTarget(st, a, { ...defaultUi(), sel: 'x' }).rows).toEqual(['p', 'q']);
    expect(planTarget(st, a, { ...defaultUi(), sel: 'x', focus: 'g' }).rows).toEqual(['a', 'b']);
  });

  it('an empty vault has no rows', () => {
    const none = state({}, []);
    expect(planTarget(none, analyze(none), defaultUi()).rows).toEqual([]);
  });
});

describe('the dialog', () => {
  it('opens with every row that has dates ticked and sub-levels on, closing the View menu', () => {
    const ui = openPlan({ ...defaultUi(), focus: 'p', viewOpen: true }, st, a);
    expect(ui.viewOpen).toBe(false);
    expect(ui.planDlg).toMatchObject({ rows: ['g', 'd'], deep: true, name: 'under Gateway' });
    expect([...ui.planDlg!.ids]).toEqual(['g']);
  });

  it('lists old and new ends, and a draft cannot be ticked', () => {
    const planned = make();
    planned.plan.g = { start: D('2026-11-02'), end: D('2026-11-20'), hours: 24 };
    const aa = analyze(planned);
    const ui = openPlan({ ...defaultUi(), focus: 'p' }, planned, aa);
    expect(planRows(planned, aa, ui.planDlg!)).toEqual([
      { id: 'g', title: 'Firmware', oldEnd: D('2026-11-20'), newEnd: aa.results.g.end, checked: true, plannable: true, group: true },
      { id: 'd', title: 'd', oldEnd: undefined, newEnd: null, checked: false, plannable: false, group: false },
    ]);
  });

  it('ticks and unticks rows, and sets sub-levels', () => {
    let ui = openPlan(defaultUi(), st, a);
    ui = togglePlanRow(ui, 'p');
    expect([...ui.planDlg!.ids]).toEqual(['q']);
    ui = togglePlanRow(ui, 'p');
    expect([...ui.planDlg!.ids].sort()).toEqual(['p', 'q']);
    expect(setPlanDeep(ui, false).planDlg!.deep).toBe(false);
  });

  it('Esc closes it first, keeping the selection', () => {
    const ui = openPlan({ ...defaultUi(), sel: 'g' }, st, a);
    expect(escape(ui, st)).toMatchObject({ planDlg: null, sel: 'g' });
  });

  it('forgets rows whose note went away, and closes when none are left', () => {
    let ui = openPlan(defaultUi(), st, a);
    const items = { ...st.items };
    delete items.q;
    ui = pruneUi(ui, { ...st, items });
    expect(ui.planDlg!.rows).toEqual(['p']);
    expect([...ui.planDlg!.ids]).toEqual(['p']);
    expect(pruneUi(ui, { ...st, items: { x: st.items.x } }).planDlg).toBeNull();
  });
});

describe('plan history', () => {
  const entry = (s: string, e: string, hours = 8) => ({ start: D(s), end: D(e), hours });

  it('is newest first, with the value before and the value it set', () => {
    const h = make();
    const first = entry('2026-11-02', '2026-11-05');
    const second = entry('2026-11-02', '2026-11-12');
    h.plan.a = second;
    h.planHistory = [
      { day: D('2026-10-01'), ids: ['a'], before: { a: undefined } },
      { day: D('2026-10-08'), ids: ['a'], before: { a: first } },
    ];
    expect(historyView(h)).toEqual([
      { day: D('2026-10-08'), rows: [{ id: 'a', title: 'a', before: first, after: second }] },
      { day: D('2026-10-01'), rows: [{ id: 'a', title: 'a', before: undefined, after: first }] },
    ]);
  });

  it('names a deleted item from its path', () => {
    const h = make();
    h.planHistory = [{ day: D('2026-10-01'), ids: ['Projects/Old job.md'], before: {} }];
    expect(historyView(h)[0].rows[0]).toMatchObject({ title: 'Old job', after: undefined });
  });

  it('is empty before the first update', () => {
    expect(historyView(make())).toEqual([]);
  });
});

describe('history dialog', () => {
  it('Esc closes it', () => {
    expect(escape({ ...defaultUi(), historyOpen: true, sel: 'q' }, st)).toMatchObject({ historyOpen: false, sel: 'q' });
  });
});
