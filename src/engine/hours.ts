import type { Day, Item } from './types';

export function setLeft(it: Item, left: number, today: Day): void {
  it.left = Math.max(0, left);
  it.touched = today;
  if (it.left < 1e-3) {
    it.left = 0;
    it.doneOn ??= today;
  } else it.doneOn = null;
}

export const setTotal = (it: Item, total: number, today: Day): void => setLeft(it, total - (it.spent ?? 0), today);

/** Moves hours from left to spent. Never moves the bar. */
export function logHours(it: Item, day: Day, h: number, today: Day): void {
  const log = (it.log ||= []);
  const entry = log.find(x => x.d === day);
  if (entry) entry.h += h;
  else log.push({ d: day, h });
  log.sort((a, b) => a.d - b.d);
  it.spent = (it.spent ?? 0) + h;
  setLeft(it, (it.left ?? 0) - h, today);
}

/** Adjusts left by the difference, so total stays the same. Editing to 0 deletes the entry. */
export function editLog(it: Item, i: number, h: number, today: Day): void {
  const log = it.log!;
  const diff = h - log[i].h;
  log[i].h = h;
  it.spent = (it.spent ?? 0) + diff;
  setLeft(it, (it.left ?? 0) - diff, today);
  if (h <= 0) log.splice(i, 1);
  if (!log.length) it.actualStart = null;
}
