import { dayOf, iso, type Item, type State } from '../../src/engine';

export const D = dayOf;

/** Spec default: today Mon 2 Nov 2026, 30 h/week, no holidays. */
export const state = (items: Record<string, Item>, tiers: string[][], weekly = 30): State => ({
  items,
  plan: {},
  tiers,
  today: D('2026-11-02'),
  settings: { weekly, staleDays: 7, holidays: [] },
});

export const task = (title: string, left: number, o: Partial<Item> = {}): Item => ({
  title,
  parent: null,
  kind: 'item',
  spent: 0,
  left,
  est: left,
  deps: [],
  ...o,
});

export const external = (title: string, start: string, end: string): Item => ({
  title,
  parent: null,
  kind: 'ext',
  pinS: D(start),
  pinE: D(end),
  deps: [],
});

export const day = (d: number | null | undefined): string | null | undefined => (d == null ? d : iso(d));
