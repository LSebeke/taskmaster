import { weekCapacity, weekOf, weekStart, type Analysis, type Day, type State } from '../../engine';

export interface LoadWeek {
  week: number;
  start: Day;
  /** Hours available this week: the capacity line. */
  cap: number;
  /** The week's own override, 0 included. Null when it follows the default. */
  override: number | null;
  segs: { root: string; hours: number }[];
  total: number;
  over: boolean;
}

export interface Load {
  weeks: LoadWeek[];
  /** Top of the scale. Over the whole span, so scrolling never rescales the strip. */
  peak: number;
}

/** The week under a chart x, or null past the strip. */
export const loadWeekAt = (load: Load, x: number, scale: { dayAt(x: number): Day }): LoadWeek | null =>
  load.weeks.find(w => w.week === weekOf(Math.floor(scale.dayAt(x)))) ?? null;

const OVER_EPS = 0.01;
/** Past any viewport at the widest zoom: the capacity line runs on after the last task. */
export const LOAD_DAYS = 3000;

/** Stacked hours per project with the capacity line, in project order. */
export function buildLoad(st: State, a: Analysis, roots: string[], span: { a: Day; b: Day }): Load {
  const weeks: LoadWeek[] = [];
  const overDays = new Set(a.over.map(o => weekOf(o.day)));
  let peak = 0;
  for (let w = weekOf(span.a), end = weekOf(span.b); w <= end; w++) {
    const hours = a.weeks[w] ?? {};
    const segs = roots.filter(r => hours[r]).map(root => ({ root, hours: hours[root] }));
    const total = segs.reduce((n, x) => n + x.hours, 0);
    const cap = weekCapacity(w, st.settings);
    weeks.push({ week: w, start: weekStart(w), cap, override: st.settings.weekCap?.[w] ?? null, segs, total, over: total > cap + OVER_EPS || overDays.has(w) });
    peak = Math.max(peak, cap, total);
  }
  return { weeks, peak };
}
