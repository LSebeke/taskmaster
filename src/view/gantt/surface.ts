import type { Spot } from './gestures';
import { loadWeekAt, type Load, type LoadWeek } from './load';
import { HEAD } from '../rows';
import type { TimeScale } from './scale';

/** The chart's elements, and how much of its bottom the load strip takes. */
export interface ChartBox {
  chart: HTMLElement;
  scroller: HTMLElement;
  loadHeight: number;
}

/** Sizes the canvas to the chart at this screen's density. Null with nothing to draw on. */
export function fitCanvas(canvas: HTMLCanvasElement, chart: HTMLElement): { c: CanvasRenderingContext2D; width: number; height: number } | null {
  const width = chart.clientWidth;
  const height = chart.clientHeight;
  if (!width || !height) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const c = canvas.getContext('2d')!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c, width, height };
}

/** Chart position among the rows, or null over the axis or the load strip. */
export function spotAt({ chart, scroller, loadHeight }: ChartBox, e: MouseEvent): Spot {
  const box = scroller.getBoundingClientRect();
  const y = e.clientY - box.top;
  if (y < HEAD || y > chart.clientHeight - loadHeight) return null;
  return { x: e.clientX - box.left + scroller.scrollLeft, y: y - HEAD + scroller.scrollTop };
}

/** The load strip week under the pointer. */
export function weekAt({ chart, scroller, loadHeight }: ChartBox, load: Load, scale: TimeScale, e: MouseEvent): LoadWeek | null {
  const box = scroller.getBoundingClientRect();
  if (e.clientY - box.top <= chart.clientHeight - loadHeight) return null;
  return loadWeekAt(load, e.clientX - box.left + scroller.scrollLeft, scale);
}
