import { isoWeekKey, iso, weekOf, weekStart, type Analysis, type Day, type State } from '../../engine';
import { MONTHS } from '../format';
import type { Axis } from '../ui-state';

const MIN_PPD = 1.5;
const MAX_PPD = 40;
/** Room a pinned month label needs before the next one pushes it out. */
const MONTH_LABEL = 64;

export interface TimeScale {
  ppd: number;
  /** First day of the chart. */
  a: Day;
  x(d: Day): number;
  dayAt(x: number): number;
}

export const makeScale = (a: Day, ppd: number): TimeScale => ({
  ppd,
  a,
  x: d => (d - a) * ppd,
  dayAt: x => a + x / ppd,
});

export const clampPpd = (p: number): number => Math.max(MIN_PPD, Math.min(MAX_PPD, p));

/** ISO week number, as on the axis. */
export const isoWeek = (d: Day): number => Number(isoWeekKey(weekOf(d)).slice(-2));

/** Everything dated, with room either side. */
export function chartSpan(st: State, a: Analysis): { a: Day; b: Day } {
  let lo = st.today;
  let hi = st.today;
  const see = (v: Day | null | undefined) => {
    if (v == null) return;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  };
  for (const id in a.results) {
    const b = a.results[id];
    const p = st.plan[id];
    see(b.start);
    see(b.end);
    see(p?.start);
    see(p?.end);
    see(st.items[id]?.deadline);
  }
  return { a: lo - 14, b: hi + 28 };
}

/** New scrollLeft that keeps the same day under `anchor`, a viewport x. */
export const zoomAround = (scrollLeft: number, anchor: number, from: number, to: number): number =>
  ((scrollLeft + anchor) / from) * to - anchor;

/** Every how many weeks a label and gridline fit at this zoom. */
export const weekEvery = (ppd: number, axis: Axis): number =>
  axis === 'cw' ? (ppd >= 3.5 ? 1 : 2) : ppd >= 10 ? 1 : ppd >= 5 ? 2 : 4;

export interface Ticks {
  /** Viewport x. */
  weeks: { x: number; label: string }[];
  months: { x: number; rule: number | null; label: string }[];
}

export function axisTicks(scale: TimeScale, scrollLeft: number, width: number, axis: Axis): Ticks {
  const startDay = Math.floor(scale.dayAt(scrollLeft));
  const endDay = Math.ceil(scale.dayAt(scrollLeft + width));
  const at = (d: Day) => scale.x(d) - scrollLeft;

  const every = weekEvery(scale.ppd, axis);
  const weeks: Ticks['weeks'] = [];
  for (let w = weekOf(startDay); weekStart(w) <= endDay; w++) {
    if (w % every !== 0) continue;
    const d = weekStart(w);
    const label = axis === 'cw' ? `${scale.ppd >= 5 ? 'CW' : ''}${isoWeek(d)}` : String(Number(iso(d).slice(8)));
    weeks.push({ x: at(d), label });
  }

  const firsts: Day[] = [];
  for (let d = startDay - 31; d <= endDay; d++) if (iso(d).endsWith('-01')) firsts.push(d);
  const months: Ticks['months'] = [];
  firsts.forEach((d, i) => {
    const x = at(d);
    const next = firsts[i + 1];
    const [y, m] = iso(d).split('-').map(Number);
    const label = `${MONTHS[m - 1]} ${y}`;
    if (x >= 0) months.push({ x, rule: x, label });
    // Still the month at the left edge: keep its name in view until the next one pushes it out.
    else if (next == null || at(next) > 0) months.push({ x: next == null ? 0 : Math.min(0, at(next) - MONTH_LABEL), rule: null, label });
  });
  return { weeks, months };
}
