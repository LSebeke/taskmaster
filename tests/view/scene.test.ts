import { describe, expect, it } from 'vitest';
import { analyze, type State } from '../../src/engine';
import { buildRows, ROW } from '../../src/view/rows';
import { hitTest } from '../../src/view/gantt/hit';
import { makeScale } from '../../src/view/gantt/scale';
import { buildScene, projectRoots } from '../../src/view/gantt/scene';
import { defaultUi, type UiState } from '../../src/view/ui-state';
import { D, external, state, task } from '../engine/helpers';

const sceneOf = (st: State, ui: UiState = defaultUi()) => {
  const a = analyze(st);
  return { a, scene: buildScene(st, a, buildRows(st, a, ui), ui) };
};
const planned = (st: State, id: string, start: string, end: string) => (st.plan[id] = { start: D(start), end: D(end), hours: 12 });

describe('scene', () => {
  it('draws the plan solid and the forecast as a ghost by default', () => {
    const st = state({ a: task('a', 12) }, [['a']]);
    planned(st, 'a', '2026-11-02', '2026-11-05');
    const [row] = sceneOf(st).scene.rows;
    expect(row.bars.map(b => [b.layer, b.role])).toEqual([['fc', 'ghost'], ['plan', 'solid']]);
    expect(row.bars[1]).toMatchObject({ d0: D('2026-11-02'), d1: D('2026-11-05') + 1 });
  });

  it('a new item has a ghost forecast bar and no plan bar', () => {
    const st = state({ a: task('a', 12) }, [['a']]);
    expect(sceneOf(st).scene.rows[0].bars.map(b => b.role)).toEqual(['ghost']);
  });

  it('draws nothing for a draft, without crashing', () => {
    const st = state({ a: task('a', 0, { est: 0 }) }, []);
    expect(sceneOf(st).scene.rows[0].bars).toEqual([]);
  });

  it('colours by project in fixed order, whatever the focus', () => {
    const st = state({ p: task('p', 0), 'p.a': task('a', 6, { parent: 'p' }), q: task('q', 0), 'q.b': task('b', 6, { parent: 'q' }) }, [['p.a', 'q.b']]);
    const { a, scene } = sceneOf(st, { ...defaultUi(), focus: 'q' });
    expect(projectRoots(st, a)).toEqual(['p', 'q']);
    expect(scene.rows[0].bars[0].color).toBe(2);
  });

  it('marks a critical ghost when Forecast is Ghost, an underline when it is Solid', () => {
    const st = state({ a: task('a', 12) }, [['a']]);
    const ghost = sceneOf(st).scene.rows[0].bars[0];
    expect(ghost).toMatchObject({ role: 'ghost', crit: true });
    const solid = sceneOf(st, { ...defaultUi(), plan: 'ghost', fc: 'solid' }).scene.rows[0].bars[0];
    expect(solid).toMatchObject({ role: 'solid', layer: 'fc', crit: true });
  });

  it('puts pinned edges on the forecast layer only, at the pin even when the bar overruns', () => {
    const st = state({ a: task('a', 60, { pinE: D('2026-11-03') }) }, [['a']]);
    planned(st, 'a', '2026-11-02', '2026-11-03');
    const [ghost, solid] = sceneOf(st).scene.rows[0].bars;
    expect(ghost.pinE).toBe(D('2026-11-03') + 1);
    expect(solid.pinE).toBeUndefined();
  });

  it('draws externals as tall neutral bars, and a done one faded', () => {
    const st = state({ x: external('x', '2026-12-01', '2026-12-04'), y: external('y', '2026-10-01', '2026-10-04') }, []);
    const { scene } = sceneOf(st);
    const bars = scene.rows.flatMap(r => r.bars);
    expect(bars.map(b => [b.kind, b.faded])).toEqual([['ext', true], ['ext', false]]);
    expect(bars[0].h).toBeGreaterThan(12);
  });

  it('draws milestones on the date, on both lanes', () => {
    const st = state({ p: task('p', 0), a: task('a', 12, { parent: 'p' }), m: { title: 'm', parent: 'p', kind: 'ms', deps: ['a'] } }, [['a']]);
    planned(st, 'm', '2026-11-03', '2026-11-03');
    const bars = sceneOf(st).scene.rows[2].bars;
    expect(bars.map(b => [b.kind, b.role])).toEqual([['ms', 'ghost'], ['ms', 'solid']]);
  });

  it('honours the milestone and deadline switches', () => {
    const st = state({ p: task('p', 0, { deadline: D('2026-12-01') }), a: task('a', 12, { parent: 'p' }), m: { title: 'm', parent: 'p', kind: 'ms', deps: ['a'] } }, [['a']]);
    const ui = defaultUi();
    expect(sceneOf(st).scene.rows[0].deadline).toBe(D('2026-12-01'));
    const off = sceneOf(st, { ...ui, show: { ...ui.show, deadlines: false, milestones: false } }).scene;
    expect(off.rows[0].deadline).toBeUndefined();
    expect(off.rows[2].bars).toEqual([]);
  });

  it('links a dependency to its dependent on the forecast lane', () => {
    const st = state({ a: task('a', 12), b: task('b', 12, { deps: ['a'] }), c: task('c', 40) }, [['c'], ['a'], ['b']]);
    const { scene } = sceneOf(st);
    const link = scene.links.find(l => l.a === 'a' && l.b === 'b')!;
    expect(link).toMatchObject({ i0: 0, i1: 1 });
    expect(link.y0).toBe(23);
  });

  it('attaches links to plan bars when Forecast is off, and to the solid lane', () => {
    const st = state({ a: task('a', 12), b: task('b', 12, { deps: ['a'] }) }, [['a'], ['b']]);
    planned(st, 'a', '2026-11-02', '2026-11-03');
    planned(st, 'b', '2026-11-10', '2026-11-12');
    const { scene } = sceneOf(st, { ...defaultUi(), fc: 'off' });
    expect(scene.links[0]).toMatchObject({ d0: D('2026-11-04'), d1: D('2026-11-10'), y0: 12 });
  });

  it('attaches links to plan bars when a hidden ghost leaves no forecast on show', () => {
    const st = state({ a: task('a', 12), b: task('b', 12, { deps: ['a'] }) }, [['a'], ['b']]);
    planned(st, 'a', '2026-11-02', '2026-11-03');
    planned(st, 'b', '2026-11-10', '2026-11-12');
    const ui = defaultUi();
    const { scene } = sceneOf(st, { ...ui, show: { ...ui.show, ghost: false } });
    expect(scene.rows[0].bars.map(b => b.role)).toEqual(['solid']);
    expect(scene.links[0]).toMatchObject({ d0: D('2026-11-04'), d1: D('2026-11-10'), y0: 12 });
  });

  it('draws no links when no bar is on show', () => {
    const st = state({ a: task('a', 12), b: task('b', 12, { deps: ['a'] }) }, [['a'], ['b']]);
    planned(st, 'a', '2026-11-02', '2026-11-03');
    planned(st, 'b', '2026-11-10', '2026-11-12');
    const ui = defaultUi();
    expect(sceneOf(st, { ...ui, plan: 'ghost', fc: 'off', show: { ...ui.show, ghost: false } }).scene.links).toEqual([]);
  });

  it('skips a link to a planless bar when Forecast is off', () => {
    const st = state({ a: task('a', 12), b: task('b', 12, { deps: ['a'] }) }, [['a'], ['b']]);
    planned(st, 'a', '2026-11-02', '2026-11-03');
    expect(sceneOf(st, { ...defaultUi(), fc: 'off' }).scene.links).toEqual([]);
  });

  it('leaves no link hanging on a hidden milestone', () => {
    const st = state({ p: task('p', 0), a: task('a', 12, { parent: 'p' }), m: { title: 'm', parent: 'p', kind: 'ms', deps: ['a'] } }, [['a']]);
    const ui = defaultUi();
    expect(sceneOf(st).scene.links.length).toBeGreaterThan(0);
    expect(sceneOf(st, { ...ui, show: { ...ui.show, milestones: false } }).scene.links).toEqual([]);
  });

  it('turns a link red when a pinned start beats its predecessor', () => {
    const st = state({ a: task('a', 60), b: task('b', 6, { deps: ['a'], pinS: D('2026-11-03') }) }, [['a'], ['b']]);
    expect(sceneOf(st).scene.links.filter(l => l.a === 'a').every(l => l.tone === 'crit')).toBe(true);
  });

  it('turns a link red for a pin inside an external it waits for', () => {
    const st = state({ x: external('x', '2026-11-03', '2026-11-05'), b: task('b', 6, { deps: ['x'], pinS: D('2026-11-05') }) }, [['b']]);
    expect(sceneOf(st).scene.links[0]).toMatchObject({ a: 'x', tone: 'crit' });
  });

  it('skips links to rows that are not shown', () => {
    const st = state({ a: task('a', 12), b: task('b', 12, { deps: ['a'] }) }, [['a'], ['b']]);
    expect(sceneOf(st, { ...defaultUi(), hidden: new Set(['a']) }).scene.links).toEqual([]);
  });

  it('keeps capacity links out unless switched on', () => {
    const st = state({ a: task('a', 12), b: task('b', 12) }, [['a'], ['b']]);
    const ui = defaultUi();
    expect(sceneOf(st).scene.links.filter(l => l.dashed)).toEqual([]);
    expect(sceneOf(st, { ...ui, show: { ...ui.show, cap: true } }).scene.links.filter(l => l.dashed).length).toBe(1);
  });
});

describe('capacity links', () => {
  it('have their own switch, whatever the critical chain does', () => {
    const st = state({ a: task('a', 12), b: task('b', 12) }, [['a'], ['b']]);
    const ui = defaultUi();
    expect(sceneOf(st, { ...ui, show: { ...ui.show, crit: false, cap: true } }).scene.links.filter(l => l.dashed).length).toBe(1);
  });
});

describe('hit-testing', () => {
  const st = state({ a: task('a', 12), b: task('b', 12) }, [['a', 'b']]);
  planned(st, 'b', '2026-11-02', '2026-11-05');
  const { scene } = sceneOf(st, { ...defaultUi() });
  const scale = makeScale(D('2026-11-02'), 10);

  it('finds the solid bar of the row under the pointer', () => {
    expect(hitTest(scene, scale, 15, ROW + 12)).toMatchObject({ id: 'b', layer: 'plan' });
  });

  it('finds the ghost lane separately', () => {
    expect(hitTest(scene, scale, 15, ROW + 23)).toMatchObject({ id: 'b', layer: 'fc' });
  });

  it('misses beyond the bar, between lanes and rows, and past the last row', () => {
    expect(hitTest(scene, scale, 500, ROW + 12)).toBeNull();
    expect(hitTest(scene, scale, 15, 1)).toBeNull();
    expect(hitTest(scene, scale, 15, ROW * 9)).toBeNull();
    expect(hitTest(scene, scale, 15, -5)).toBeNull();
  });

  it('allows a few pixels of slack at the ends', () => {
    expect(hitTest(scene, scale, -2, ROW + 12)).toMatchObject({ id: 'b' });
  });

  it('hits a milestone around its date at any zoom', () => {
    const s2 = state({ p: task('p', 0), m: { title: 'm', parent: 'p', kind: 'ms', pinE: D('2026-11-10'), deps: [] } }, []);
    const sc = sceneOf(s2, { ...defaultUi(), plan: 'off', fc: 'solid' }).scene;
    const tight = makeScale(D('2026-11-02'), 1.5);
    expect(hitTest(sc, tight, tight.x(D('2026-11-10')) + 2, ROW + 11)).toMatchObject({ id: 'm' });
  });

});
