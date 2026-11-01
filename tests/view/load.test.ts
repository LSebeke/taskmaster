import { describe, expect, it } from 'vitest';
import { analyze, weekOf } from '../../src/engine';
import { buildLoad, loadWeekAt } from '../../src/view/gantt/load';
import { makeScale } from '../../src/view/gantt/scale';
import { D, state, task } from '../engine/helpers';

const W = weekOf(D('2026-11-02'));
const span = { a: D('2026-11-02'), b: D('2026-11-29') };
const load = (st: ReturnType<typeof state>) => buildLoad(st, analyze(st), ['a'], span);

describe('load strip', () => {
  it('finds the week under a chart x, across the whole Monday to Sunday', () => {
    const l = load(state({ a: task('a', 12) }, [['a']]));
    const scale = makeScale(D('2026-11-02'), 10);
    expect(loadWeekAt(l, 0, scale)!.week).toBe(W);
    expect(loadWeekAt(l, 69, scale)!.week).toBe(W);
    expect(loadWeekAt(l, 70, scale)!.week).toBe(W + 1);
    expect(loadWeekAt(l, 100000, scale)).toBeNull();
  });

  it('has one entry per week of the span, at full capacity with no holidays', () => {
    const { weeks } = load(state({ a: task('a', 12) }, [['a']]));
    expect(weeks.map(w => w.week)).toEqual([W, W + 1, W + 2, W + 3]);
    expect(weeks.map(w => w.cap)).toEqual([30, 30, 30, 30]);
    expect(weeks[0].segs).toEqual([{ root: 'a', hours: 12 }]);
  });

  it('lowers the line in holiday weeks', () => {
    const st = state({ a: task('a', 12) }, [['a']]);
    st.settings.holidays = [D('2026-11-11'), D('2026-11-12')];
    expect(load(st).weeks.map(w => w.cap)).toEqual([30, 18, 30, 30]);
  });

  it('steps the line with an override, which still loses holidays, and labels only that week', () => {
    const st = state({ a: task('a', 12) }, [['a']]);
    st.settings.weekCap = { [W + 1]: 60 };
    st.settings.holidays = [D('2026-11-11')];
    const { weeks } = load(st);
    expect(weeks.map(w => w.cap)).toEqual([30, 48, 30, 30]);
    expect(weeks.map(w => w.override)).toEqual([null, 60, null, null]);
  });

  it('labels an override of zero', () => {
    const st = state({ a: task('a', 12) }, [['a']]);
    st.settings.weekCap = { [W + 2]: 0 };
    const { weeks } = load(st);
    expect(weeks[2].cap).toBe(0);
    expect(weeks[2].override).toBe(0);
  });

  it('marks a week overbooked against its own capacity, not the default', () => {
    const st = state({ a: task('a', 10, { pinS: D('2026-11-02'), pinE: D('2026-11-06') }) }, [['a']]);
    st.settings.weekCap = { [W]: 5 };
    const { weeks } = load(st);
    expect(weeks[0].over).toBe(true);
    expect(weeks[1].over).toBe(false);
  });

  it('scales to the highest of any capacity or load, so a large override stays on the strip', () => {
    const st = state({ a: task('a', 12) }, [['a']]);
    st.settings.weekCap = { [W + 3]: 90 };
    expect(load(st).peak).toBe(90);
  });
});
