import type { Analysis, Day, State } from '../../engine';
import type { TimeScale } from './scale';
import type { Bar, SceneRow } from './scene';

export type DragMode = 'body' | 'start' | 'end';

export interface Pins {
  s?: Day;
  e?: Day;
}

const EDGE_PX = 7;
/** Below this a bar has no room for edges. */
const MIN_EDGED_PX = 18;
const DOT_GAP = 9;
const DOT_GAP_MS = 14;
export const DOT_R = 4;
const DOT_HIT = 8;

export function dragZone(x0: number, x1: number, x: number): DragMode {
  if (x1 - x0 <= MIN_EDGED_PX) return 'body';
  if (x < x0 + EDGE_PX) return 'start';
  return x > x1 - EDGE_PX ? 'end' : 'body';
}

/** Only forecast bars of unfinished tasks and external bars drag. */
export function canDrag(st: State, a: Analysis, bar: Bar): boolean {
  if (bar.layer !== 'fc') return false;
  if (bar.kind === 'ext') return true;
  return bar.kind === 'bar' && !a.kids[bar.id] && !a.results[bar.id]?.done && st.items[bar.id]?.kind === 'item';
}

/** Pins after dragging by `days` from where the bar was. An edge stops at the other edge. */
export function dragPins(base: { s: Day; e: Day }, mode: DragMode, days: number): Pins {
  if (mode === 'body') return { s: base.s + days, e: base.e + days };
  if (mode === 'start') return { s: Math.min(base.s + days, base.e) };
  return { e: Math.max(base.e + days, base.s) };
}

/** A state to run the schedule on mid-drag. Shares everything but the one item. */
export const withPins = (st: State, id: string, pins: Pins): State => ({
  ...st,
  items: { ...st.items, [id]: { ...st.items[id], ...(pins.s != null && { pinS: pins.s }), ...(pins.e != null && { pinE: pins.e }) } },
});

export const forecastBar = (row: SceneRow | undefined): Bar | undefined => row?.bars.find(b => b.layer === 'fc');

/** The link dot: past the bar's end, in chart x and height inside the row. */
export function dotAt(bar: Bar, scale: TimeScale): { x: number; y: number } {
  if (bar.kind === 'ms') return { x: scale.x(bar.startDay + 0.5) + DOT_GAP_MS, y: bar.top };
  return { x: scale.x(bar.endDay) + DOT_GAP, y: bar.top + bar.h / 2 };
}

export function overDot(bar: Bar, scale: TimeScale, x: number, y: number): boolean {
  const dot = dotAt(bar, scale);
  return Math.hypot(x - dot.x, y - dot.y) <= DOT_HIT;
}
