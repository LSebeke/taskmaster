import { describe, expect, it } from 'vitest';
import { analyze, dayOf as D, type Item, type State } from '../../src/engine';
import { dotAt, dragPins, dragZone, canDrag, forecastBar, withPins } from '../../src/view/gantt/drag';
import { makeScale } from '../../src/view/gantt/scale';
import { buildScene } from '../../src/view/gantt/scene';
import { buildRows } from '../../src/view/rows';
import { defaultUi, type UiState } from '../../src/view/ui-state';

const today = D('2026-11-02');
const state = (items: Record<string, Partial<Item>>, tiers: string[][] = []): State => ({
  items: Object.fromEntries(Object.entries(items).map(([id, o]) => [id, { title: id, parent: null, kind: 'item', deps: [], ...o }])),
  plan: {},
  tiers,
  today,
  settings: { weekly: 30, staleDays: 7, holidays: [] },
});

const bars = (st: State, ui: UiState = defaultUi()) => {
  const a = analyze(st);
  const scene = buildScene(st, a, buildRows(st, a, ui), ui);
  const of = (id: string) => forecastBar(scene.rows.find(r => r.id === id)!);
  return { a, of };
};

describe('dragZone', () => {
  it('splits a wide bar into edges and body', () => {
    expect(dragZone(100, 200, 103)).toBe('start');
    expect(dragZone(100, 200, 150)).toBe('body');
    expect(dragZone(100, 200, 198)).toBe('end');
  });

  it('a bar too narrow for edges is all body', () => {
    expect(dragZone(100, 112, 101)).toBe('body');
    expect(dragZone(100, 112, 111)).toBe('body');
  });
});

describe('dragPins', () => {
  const base = { s: D('2026-11-02'), e: D('2026-11-06') };

  it('body pins both edges, moved together', () => {
    expect(dragPins(base, 'body', 7)).toEqual({ s: D('2026-11-09'), e: D('2026-11-13') });
    expect(dragPins(base, 'body', -3)).toEqual({ s: D('2026-10-30'), e: D('2026-11-03') });
  });

  it('an edge pins only itself', () => {
    expect(dragPins(base, 'end', 3)).toEqual({ e: D('2026-11-09') });
    expect(dragPins(base, 'start', 2)).toEqual({ s: D('2026-11-04') });
  });

  it('an edge stops at the other edge', () => {
    expect(dragPins(base, 'start', 30)).toEqual({ s: base.e });
    expect(dragPins(base, 'end', -30)).toEqual({ e: base.s });
  });
});

describe('canDrag', () => {
  const st = state(
    {
      par: {},
      kid: { parent: 'par', left: 12 },
      done: { parent: 'par', left: 0, spent: 4, doneOn: today - 1 },
      m: { kind: 'ms', parent: 'par' },
      x: { kind: 'ext', pinS: today, pinE: today + 2 },
    },
    [['kid']],
  );

  it('takes forecast bars of unfinished tasks, and external bars', () => {
    const { a, of } = bars(st);
    expect(canDrag(st, a, of('kid')!)).toBe(true);
    expect(canDrag(st, a, of('x')!)).toBe(true);
  });

  it('refuses parents, milestones and finished tasks', () => {
    const { a, of } = bars(st);
    expect(canDrag(st, a, of('par')!)).toBe(false);
    expect(canDrag(st, a, of('m')!)).toBe(false);
    expect(canDrag(st, a, of('done')!)).toBe(false);
  });

  it('refuses plan bars, in either role', () => {
    const planned: State = { ...st, plan: { kid: { start: today, end: today + 2, hours: 12 } } };
    const { a } = bars(planned);
    const ui = { ...defaultUi(), plan: 'solid', fc: 'ghost' } as UiState;
    const scene = buildScene(planned, a, buildRows(planned, a, ui), ui);
    const plan = scene.rows.find(r => r.id === 'kid')!.bars.find(b => b.layer === 'plan')!;
    expect(plan).toBeDefined();
    expect(canDrag(planned, a, plan)).toBe(false);
  });

  it('works in Solid as in Ghost, and there is no forecast bar when Forecast is off', () => {
    const solid = bars(st, { ...defaultUi(), plan: 'ghost', fc: 'solid' });
    expect(canDrag(st, solid.a, solid.of('kid')!)).toBe(true);
    expect(bars(st, { ...defaultUi(), fc: 'off' }).of('kid')).toBeUndefined();
  });
});

describe('dotAt', () => {
  it('sits just past the end of the bar, at its height', () => {
    const scale = makeScale(today, 10);
    const bar = { kind: 'bar', d0: today, d1: today + 5, top: 21, h: 4 } as never;
    const dot = dotAt(bar, scale);
    expect(dot.x).toBeGreaterThan(50);
    expect(dot.x).toBeLessThan(62);
    expect(dot.y).toBe(23);
  });
});

describe('withPins', () => {
  it('leaves the real state alone', () => {
    const st = state({ a: { left: 12 } }, [['a']]);
    const pre = withPins(st, 'a', { s: today + 3 });
    expect(pre.items.a.pinS).toBe(today + 3);
    expect(st.items.a.pinS).toBeUndefined();
  });
});
