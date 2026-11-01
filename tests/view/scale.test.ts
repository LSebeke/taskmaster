import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/engine';
import { axisTicks, chartSpan, clampPpd, isoWeek, makeScale, zoomAround } from '../../src/view/gantt/scale';
import { D, state, task } from '../engine/helpers';

describe('time scale', () => {
  it('maps days to pixels and back', () => {
    const s = makeScale(D('2026-11-01'), 10);
    expect(s.x(D('2026-11-03'))).toBe(20);
    expect(s.dayAt(25)).toBe(D('2026-11-03') + 0.5);
  });

  it('numbers ISO weeks, including the year boundary', () => {
    expect(isoWeek(D('2026-11-02'))).toBe(45);
    expect(isoWeek(D('2026-12-31'))).toBe(53);
    expect(isoWeek(D('2027-01-03'))).toBe(53);
    expect(isoWeek(D('2027-01-04'))).toBe(1);
  });

  it('spans all dates with margin, and copes with nothing scheduled', () => {
    const st = state({ a: task('a', 12, { deadline: D('2026-12-01') }) }, [['a']]);
    expect(chartSpan(st, analyze(st))).toEqual({ a: D('2026-11-02') - 14, b: D('2026-12-01') + 28 });
    const empty = state({}, []);
    expect(chartSpan(empty, analyze(empty))).toEqual({ a: D('2026-11-02') - 14, b: D('2026-11-02') + 28 });
  });

  it('keeps the day under the cursor fixed when zooming', () => {
    const scrollLeft = zoomAround(700, 100, 7, 14);
    expect((scrollLeft + 100) / 14).toBeCloseTo((700 + 100) / 7);
  });

  it('clamps zoom', () => {
    expect(clampPpd(0.1)).toBe(1.5);
    expect(clampPpd(99)).toBe(40);
  });

  it('labels weeks by date or CW, and months with the year', () => {
    const scale = makeScale(D('2026-11-02'), 12);
    const date = axisTicks(scale, 0, 400, 'date');
    expect(date.weeks[0]).toMatchObject({ x: 0, label: '2' });
    expect(date.months.map(m => m.label)).toEqual(['Nov 2026', 'Dec 2026']);
    expect(axisTicks(scale, 0, 400, 'cw').weeks[0].label).toBe('CW45');
  });

  it('pins the month label to the left edge while its first day is scrolled away', () => {
    const scale = makeScale(D('2026-11-01'), 7);
    const { months } = axisTicks(scale, 70, 200, 'date');
    expect(months[0]).toMatchObject({ label: 'Nov 2026', x: 0 });
  });
});
