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
