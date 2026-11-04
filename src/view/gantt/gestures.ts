import { depError, type Analysis, type State } from '../../engine';
import { addDep, setPins, type Edit } from '../../store/edits';
import { fmtD } from '../format';
import { ROW } from '../rows';
import { canDrag, dotAt, dragPins, dragZone, forecastBar, overDot, withPins, type DragMode, type Pins } from './drag';
import type { TimeScale } from './scale';
import type { Bar, Scene } from './scene';

const MOVE_PX = 3;

/** What the chart draws over itself for a gesture. Chart x, y from the first row's top. */
export interface Hot {
  /** Row showing its link dot. */
  row: number | null;
  link: { x0: number; y0: number; x1: number; y1: number; target: number | null; ok: boolean } | null;
}

/** Pointer position, chart x and y from the first row's top. Null off the rows. */
export type Spot = { x: number; y: number } | null;

export interface GestureHost {
  readonly el: HTMLElement;
  /** The store's state, never a preview. */
  readonly state: State;
  readonly analysis: Analysis;
  readonly scene: Scene;
  readonly scale: TimeScale;
  spot(e: PointerEvent): Spot;
  hit(e: PointerEvent): Bar | null;
  /** Shows a schedule without storing it. Null goes back to the store. */
  preview(st: State | null): void;
  /** Ends a preview with a real edit. */
  commit(edit: Edit): void;
  /** Status bar line for what an edit would do. */
  consequence(label: string, edit?: Edit): string;
  say(text: string): void;
  paintHot(hot: Hot): void;
}

interface BarDrag {
  type: 'bar';
  id: string;
  mode: DragMode;
  startX: number;
  base: { s: number; e: number };
  days: number;
  moved: boolean;
  pins: Pins | null;
}

interface LinkDrag {
  type: 'link';
  from: string;
  x0: number;
  y0: number;
  target: string | null;
  error: string | null;
}

/** Bar drags and drag-to-link. Pure geometry lives in drag.ts: this holds the state between events. */
export class Gestures {
  private now: BarDrag | LinkDrag | null = null;
  private hotRow: number | null = null;
  /** The click after a real drag is not a click. */
  private swallowClick = false;

  constructor(private host: GestureHost) {}

  get active() {
    return this.now != null;
  }

  takeClick(): boolean {
    const swallow = this.swallowClick;
    this.swallowClick = false;
    return swallow;
  }

  down(e: PointerEvent) {
    this.swallowClick = false;
    if (e.button !== 0) return;
    const { host } = this;
    const p = host.spot(e);
    if (!p) return;
    const i = Math.floor(p.y / ROW);
    const row = host.scene.rows[i];
    const fc = forecastBar(row);
    if (fc && overDot(fc, host.scale, p.x, p.y - i * ROW)) {
      const dot = dotAt(fc, host.scale);
      this.now = { type: 'link', from: fc.id, x0: dot.x, y0: i * ROW + dot.y, target: null, error: null };
      host.say(`Drag to the item that should wait for ${host.state.items[fc.id].title}`);
      host.el.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    const bar = host.hit(e);
    if (!bar || !canDrag(host.state, host.analysis, bar)) return;
    const b = host.analysis.results[bar.id];
    if (b.start == null || b.end == null) return;
    this.now = {
      type: 'bar',
      id: bar.id,
      mode: dragZone(host.scale.x(bar.startDay), host.scale.x(bar.endDay), p.x),
      startX: e.clientX + host.el.scrollLeft,
      base: { s: b.start, e: b.end },
      days: 0,
      moved: false,
      pins: null,
    };
    host.el.setPointerCapture(e.pointerId);
  }

  /** True when a gesture took the event. */
  move(e: PointerEvent): boolean {
    const g = this.now;
    if (!g) return false;
    if (g.type === 'bar') this.moveBar(g, e);
    else this.moveLink(g, e);
    return true;
  }

  up(e: PointerEvent) {
    const g = this.now;
    if (!g) return;
    this.now = null;
    this.host.el.releasePointerCapture?.(e.pointerId);
    if (g.type === 'bar') {
      this.swallowClick = g.moved;
      if (g.pins) this.host.commit(setPins(g.id, g.pins));
      else if (g.moved) this.host.preview(null);
    } else {
      this.swallowClick = true;
      this.host.paintHot({ row: this.hotRow, link: null });
      if (g.target && !g.error) this.host.commit(addDep(g.target, g.from));
      else this.host.say(g.error ? `⚠ ${g.error}` : '');
    }
  }

  /** Esc mid-gesture. True if there was one. */
  cancel(): boolean {
    const g = this.now;
    if (!g) return false;
    this.now = null;
    this.swallowClick = true;
    if (g.type === 'bar') this.host.preview(null);
    else this.host.paintHot({ row: this.hotRow, link: null });
    this.host.say('');
    return true;
  }

  /** Shows the dot for the row under the pointer. Returns the cursor to use. */
  hover(e: PointerEvent | null, bar: Bar | null): string {
    const { host } = this;
    const p = e && host.spot(e);
    const i = p ? Math.floor(p.y / ROW) : null;
    const row = i != null ? host.scene.rows[i] : undefined;
    const fc = forecastBar(row);
    const next = fc ? i : null;
    if (next !== this.hotRow) {
      this.hotRow = next;
      host.paintHot({ row: next, link: null });
    }
    if (p && fc && overDot(fc, host.scale, p.x, p.y - i! * ROW)) return 'crosshair';
    if (!bar) return '';
    if (p && canDrag(host.state, host.analysis, bar)) return dragZone(host.scale.x(bar.startDay), host.scale.x(bar.endDay), p.x) === 'body' ? 'grab' : 'ew-resize';
    return 'pointer';
  }

  private moveBar(g: BarDrag, e: PointerEvent) {
    const { host } = this;
    const dx = e.clientX + host.el.scrollLeft - g.startX;
    if (Math.abs(dx) > MOVE_PX) g.moved = true;
    if (!g.moved) return;
    const days = Math.round(dx / host.scale.ppd);
    if (days === g.days) return;
    g.days = days;
    g.pins = days ? dragPins(g.base, g.mode, days) : null;
    host.preview(g.pins ? withPins(host.state, g.id, g.pins) : null);
    const { title } = host.state.items[g.id];
    if (g.pins) host.say(host.consequence(`${title}: ${[g.pins.s, g.pins.e].filter(d => d != null).map(fmtD).join(' → ')}`));
    else host.say('');
  }

  private moveLink(g: LinkDrag, e: PointerEvent) {
    const { host } = this;
    const p = host.spot(e);
    const i = p ? Math.floor(p.y / ROW) : null;
    const row = i != null ? host.scene.rows[i] : undefined;
    const target = row && !row.section && row.id !== g.from ? row.id : null;
    if (target !== g.target) {
      g.target = target;
      g.error = target ? depError(host.state, target, g.from) : null;
      const { items } = host.state;
      if (!target) host.say(`Drag to the item that should wait for ${items[g.from].title}`);
      else if (g.error) host.say(`⚠ ${g.error}`);
      else host.say(host.consequence(`${items[target].title} would wait for ${items[g.from].title}`, addDep(target, g.from)));
    }
    host.paintHot({
      row: this.hotRow,
      link: { x0: g.x0, y0: g.y0, x1: p?.x ?? g.x0, y1: p?.y ?? g.y0, target: target ? i : null, ok: !g.error },
    });
  }
}
