import type { Day, Settings } from './types';

const DAY_MS = 864e5;

export const dayOf = (s: string): Day => Math.round(Date.parse(`${s}T00:00:00Z`) / DAY_MS);
export const iso = (d: Day): string => new Date(d * DAY_MS).toISOString().slice(0, 10);

/** 0 Sunday to 6 Saturday. */
const dow = (d: Day) => (d + 4) % 7;

export const isWork = (d: Day, s: Settings): boolean => {
  const w = dow(d);
  return w >= 1 && w <= 5 && !s.holidays.includes(d);
};

export const workDays = (a: Day, b: Day, s: Settings): number => {
  let n = 0;
  for (let d = a; d <= b; d++) if (isWork(d, s)) n++;
  return n;
};

/** Weeks run Monday to Sunday. */
export const weekOf = (d: Day): number => Math.floor((d + 3) / 7);
export const weekStart = (w: number): Day => w * 7 - 3;

/** A full week's hours: its override, else the default. */
export const weekHours = (w: number, s: Settings): number => s.weekCap?.[w] ?? s.weekly;

/** Hours actually available in a week, after holidays. */
export const weekCapacity = (w: number, s: Settings): number => {
  const a = weekStart(w);
  return (weekHours(w, s) / 5) * workDays(a, a + 6, s);
};

/** ISO label such as `2026-W50`. The ISO year is the year of the week's Thursday. */
export const isoWeekKey = (w: number): string => {
  const year = iso(weekStart(w) + 3).slice(0, 4);
  const n = w - weekOf(dayOf(`${year}-01-04`)) + 1;
  return `${year}-W${String(n).padStart(2, '0')}`;
};

/** Inverse of `isoWeekKey`. Undefined for anything that is not a real ISO week. */
export const weekOfIsoKey = (key: string): number | undefined => {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return undefined;
  const w = weekOf(dayOf(`${m[1]}-01-04`)) + Number(m[2]) - 1;
  return isoWeekKey(w) === key ? w : undefined;
};
