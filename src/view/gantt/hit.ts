import { ROW } from '../rows';
import type { TimeScale } from './scale';
import type { Bar, Scene } from './scene';

/** The bar at a chart x and a y measured from the first row's top. Later bars sit on top. */
export function hitTest(scene: Scene, scale: TimeScale, x: number, y: number): Bar | null {
  const i = Math.floor(y / ROW);
  const row = scene.rows[i];
  if (!row) return null;
  const inside = y - i * ROW;
  for (let k = row.bars.length - 1; k >= 0; k--) {
    const b = row.bars[k];
    if (inside < b.y0 || inside > b.y1) continue;
    const x0 = b.kind === 'ms' ? scale.x(b.startDay + 0.5) : scale.x(b.startDay);
    const x1 = b.kind === 'ms' ? x0 : scale.x(b.endDay);
    if (x >= x0 - b.slack && x <= x1 + b.slack) return b;
  }
  return null;
}
