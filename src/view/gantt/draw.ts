import { isWork, type State } from '../../engine';
import { fmtD } from '../format';
import { HEAD, LOADH, ROW } from '../rows';
import type { UiState } from '../ui-state';
import { DOT_R, dotAt, forecastBar } from './drag';
import type { Hot } from './gestures';
import type { Load } from './load';
import type { Palette } from './palette';
import { axisTicks, isoWeek, type TimeScale } from './scale';
import type { Bar, Scene } from './scene';

export interface Frame {
  st: State;
  ui: UiState;
  scene: Scene;
  load: Load;
  scale: TimeScale;
  pal: Palette;
  width: number;
  height: number;
  scrollLeft: number;
  scrollTop: number;
  hot: Hot;
}

const WEEKEND_MIN_PPD = 4;
const PILL_TOP = 18;
const PILL_H = 16;
const LOAD_LABEL_H = 18;
const LOAD_FILL = 0.92;

const pillar = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  const width = Math.max(w, 1);
  c.beginPath();
  c.roundRect(x, y, width, h, Math.max(0, Math.min(r, width / 2, h / 2)));
  c.fill();
};

const color = (pal: Palette, n: number) => (n ? pal[`c${n}` as 'c1'] : pal.ink2);

function drawBar(c: CanvasRenderingContext2D, b: Bar, f: Frame, y: number) {
  const { scale, pal, scrollLeft } = f;
  const x0 = scale.x(b.d0) - scrollLeft;
  const w = scale.x(b.d1) - scale.x(b.d0);
  const top = y + b.top;

  if (b.kind === 'ext') {
    c.fillStyle = pal.ink2;
    c.globalAlpha = b.faded ? 0.25 : 0.55;
    pillar(c, x0, top, w, b.h, 3);
    c.globalAlpha = 1;
    if (b.crit) {
      c.fillStyle = pal.crit;
      c.fillRect(x0, top + b.h + 1, w, 2);
    }
    return;
  }

  if (b.kind === 'ms') {
    const cx = scale.x(b.d0 + 0.5) - scrollLeft;
    c.globalAlpha = b.role === 'ghost' ? 0.5 : 1;
    c.fillStyle = color(pal, b.color);
    c.beginPath();
    c.moveTo(cx, top - b.h);
    c.lineTo(cx + b.h, top);
    c.lineTo(cx, top + b.h);
    c.lineTo(cx - b.h, top);
    c.fill();
    c.globalAlpha = 1;
    return;
  }

  if (b.role === 'ghost') {
    c.fillStyle = b.crit ? pal.crit : pal.muted;
    pillar(c, x0, top, w, b.h, 2);
  } else {
    c.fillStyle = color(pal, b.color);
    c.globalAlpha = 0.32;
    pillar(c, x0, top, w, b.h, 4);
    c.globalAlpha = 1;
    if (b.pct > 0) pillar(c, x0, top, b.pct * w, b.h, 4);
    if (b.crit) {
      c.fillStyle = pal.crit;
      c.fillRect(x0, top + b.h + 1, w, 2);
    }
  }
  c.fillStyle = pal.ink;
  const pinTop = b.role === 'ghost' ? top - 2 : top + 2;
  const pinH = b.role === 'ghost' ? 8 : b.h - 4;
  if (b.pinS != null) c.fillRect(scale.x(b.pinS) - scrollLeft - 3, pinTop, 6, pinH);
  if (b.pinE != null) c.fillRect(scale.x(b.pinE) - scrollLeft - 3, pinTop, 6, pinH);
}

function drawDeadline(c: CanvasRenderingContext2D, f: Frame, day: number, y: number) {
  const { scale, pal, scrollLeft } = f;
  const x = scale.x(day) - scrollLeft;
  const w = scale.ppd;
  c.fillStyle = pal.crit;
  c.beginPath();
  c.moveTo(x, y + 3);
  c.lineTo(x + w, y + 3);
  c.lineTo(x + w / 2, y + 3 + w * 0.8);
  c.fill();
  c.fillRect(x + w / 2 - 0.5, y + 3, 1, ROW - 8);
}

function drawLinks(c: CanvasRenderingContext2D, f: Frame, bottom: number) {
  const { scene, scale, pal, scrollLeft, scrollTop, width } = f;
  const yAt = (i: number, inside: number) => HEAD + i * ROW - scrollTop + inside;
  for (const l of scene.links) {
    const y0 = yAt(l.i0, l.y0);
    const y1 = yAt(l.i1, l.y1);
    if (Math.max(y0, y1) < HEAD || Math.min(y0, y1) > bottom) continue;
    const x0 = scale.x(l.d0) - scrollLeft;
    const x1 = scale.x(l.d1) - scrollLeft;
    const mid = x1 > x0 + 10 ? x1 - 5 : x0 + 5;
    if (Math.max(x0, x1, mid) < 0 || Math.min(x0, x1, mid) > width) continue;
    c.strokeStyle = l.tone === 'crit' ? pal.crit : pal.axis;
    c.lineWidth = l.width;
    c.setLineDash(l.dashed ? [4, 3] : []);
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(mid, y0);
    c.lineTo(mid, y1);
    c.lineTo(x1, y1);
    c.stroke();
  }
  c.setLineDash([]);
}

/** The link dot under the pointer, and the line of a link being dragged. */
function drawHot(c: CanvasRenderingContext2D, f: Frame) {
  const { hot, scene, scale, pal, scrollLeft, scrollTop, width } = f;
  const { link } = hot;
  const yOf = (i: number) => HEAD + i * ROW - scrollTop;
  if (link?.target != null) {
    c.fillStyle = link.ok ? pal.accent : pal.crit;
    c.globalAlpha = 0.18;
    c.fillRect(0, yOf(link.target), width, ROW - 1);
    c.globalAlpha = 1;
  }
  const bar = hot.row != null && !link ? forecastBar(scene.rows[hot.row]) : undefined;
  if (bar) {
    const dot = dotAt(bar, scale);
    c.fillStyle = pal.surface;
    c.strokeStyle = pal.accent;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(dot.x - scrollLeft, yOf(hot.row!) + dot.y, DOT_R, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  }
  if (link) {
    const x0 = link.x0 - scrollLeft;
    const y0 = HEAD + link.y0 - scrollTop;
    const x1 = link.x1 - scrollLeft;
    const y1 = HEAD + link.y1 - scrollTop;
    c.strokeStyle = link.ok ? pal.accent : pal.crit;
    c.fillStyle = c.strokeStyle;
    c.lineWidth = 2;
    c.setLineDash([5, 4]);
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
    c.setLineDash([]);
    c.beginPath();
    c.arc(x0, y0, DOT_R, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.arc(x1, y1, 3, 0, Math.PI * 2);
    c.fill();
  }
}

function drawAxis(c: CanvasRenderingContext2D, f: Frame) {
  const { st, ui, scale, pal, width, scrollLeft } = f;
  c.fillStyle = pal.surface;
  c.fillRect(0, 0, width, HEAD);
  c.fillStyle = pal.axis;
  c.fillRect(0, HEAD - 1, width, 1);
  c.font = `11px ${pal.font}`;
  c.textBaseline = 'alphabetic';

  const ticks = axisTicks(scale, scrollLeft, width, ui.axis);
  for (const m of ticks.months) {
    c.fillStyle = pal.ink2;
    c.fillText(m.label, m.x + 4, 14);
    if (m.rule != null) {
      c.fillStyle = pal.axis;
      c.fillRect(Math.round(m.rule), 0, 1, HEAD);
    }
  }
  c.fillStyle = pal.muted;
  for (const w of ticks.weeks) c.fillText(w.label, w.x + 3, 33);

  if (ui.show.today) {
    const x = scale.x(st.today) - scrollLeft;
    const label = `Today ${ui.axis === 'cw' ? `CW${isoWeek(st.today)}` : fmtD(st.today)}`;
    const w = c.measureText(label).width + 10;
    c.fillStyle = pal.accent;
    pillar(c, x - w / 2, PILL_TOP, w, PILL_H, 4);
    c.fillStyle = pal['on-accent'];
    c.fillText(label, x - w / 2 + 5, 30);
  }
}

function drawLoad(c: CanvasRenderingContext2D, f: Frame, top: number) {
  const { load, scale, pal, width, height, scrollLeft, st, ui } = f;
  c.fillStyle = pal.surface;
  c.fillRect(0, top, width, LOADH);
  c.fillStyle = pal.axis;
  c.fillRect(0, top, width, 1);

  const base = height - 4;
  const sc = load.peak > 0 ? ((LOADH - LOAD_LABEL_H) / load.peak) * LOAD_FILL : 0;
  const gap = Math.max(2, Math.min(6, scale.ppd));
  const weekW = 7 * scale.ppd;
  const visible = load.weeks.filter(w => {
    const x = scale.x(w.start) - scrollLeft;
    return x < width && x + weekW > 0;
  });

  c.font = `10px ${pal.font}`;
  for (const w of visible) {
    const x = scale.x(w.start) - scrollLeft;
    const bw = weekW - gap;
    let y = base;
    for (const s of w.segs) {
      const n = f.scene.rootColors.get(s.root) ?? 0;
      const h = Math.max(1, s.hours * sc - 1);
      c.fillStyle = color(pal, n);
      c.fillRect(x, y - h, bw, h);
      y -= s.hours * sc;
    }
    if (w.over && ui.show.conflicts) {
      c.fillStyle = pal.crit;
      c.fillText('▲', x + bw / 2 - 4, y - 2);
    }
  }

  // The line steps week by week: holidays and overrides both move it.
  c.strokeStyle = pal.ink2;
  c.lineWidth = 1;
  c.beginPath();
  visible.forEach((w, i) => {
    const x = Math.round(scale.x(w.start) - scrollLeft);
    const y = Math.round(base - w.cap * sc) + 0.5;
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
    c.lineTo(Math.round(x + weekW), y);
  });
  c.stroke();

  for (const w of visible) {
    if (w.override == null) continue;
    const x = scale.x(w.start) - scrollLeft;
    const y = Math.round(base - w.cap * sc);
    const label = `${w.override}h`;
    const tw = c.measureText(label).width + 4;
    const labelY = Math.max(top + 12, y - 2);
    c.fillStyle = pal.ink2;
    c.fillRect(x, Math.round(y) - 1, weekW, 2);
    c.fillStyle = pal.surface;
    c.fillRect(x + 1, labelY - 9, tw, 11);
    c.fillStyle = pal.ink;
    c.fillText(label, x + 3, labelY);
  }

  if (ui.show.today) {
    c.fillStyle = pal.accent;
    c.fillRect(Math.round(scale.x(st.today) - scrollLeft), top, 2, LOADH);
  }
}

/** One frame. Reads only precomputed geometry, so scrolling and zooming stay cheap. */
export function drawGantt(c: CanvasRenderingContext2D, f: Frame) {
  const { st, ui, scene, scale, pal, width, height, scrollLeft, scrollTop } = f;
  const { show } = ui;
  const bottom = height - (show.load ? LOADH : 0);
  c.clearRect(0, 0, width, height);

  const d0 = Math.floor(scale.dayAt(scrollLeft));
  const d1 = Math.ceil(scale.dayAt(scrollLeft + width));
  if (show.nonwork && scale.ppd >= WEEKEND_MIN_PPD) {
    c.fillStyle = pal.grid;
    c.globalAlpha = 0.35;
    for (let d = d0; d <= d1; d++) if (!isWork(d, st.settings)) c.fillRect(scale.x(d) - scrollLeft, HEAD, scale.ppd, bottom - HEAD);
    c.globalAlpha = 1;
  }
  if (show.grid) {
    c.fillStyle = pal.grid;
    for (const t of axisTicks(scale, scrollLeft, width, ui.axis).weeks) c.fillRect(Math.round(t.x), HEAD, 1, bottom - HEAD);
  }

  c.save();
  c.beginPath();
  c.rect(0, HEAD, width, bottom - HEAD);
  c.clip();

  const sel = ui.sel ? st.items[ui.sel] : null;
  if (sel?.kind === 'ext' && show.ext) {
    c.fillStyle = pal.ink2;
    c.globalAlpha = 0.1;
    c.fillRect(scale.x(sel.pinS!) - scrollLeft, HEAD, (sel.pinE! - sel.pinS! + 1) * scale.ppd, bottom - HEAD);
    c.globalAlpha = 1;
  }

  const i0 = Math.max(0, Math.floor(scrollTop / ROW) - 1);
  const i1 = Math.min(scene.rows.length, Math.ceil((scrollTop + bottom) / ROW) + 1);
  for (let i = i0; i < i1; i++) {
    const row = scene.rows[i];
    const y = HEAD + i * ROW - scrollTop;
    c.fillStyle = pal.grid;
    if (show.grid) c.fillRect(0, y + ROW - 1, width, 1);
    if (ui.sel === row.id) {
      c.globalAlpha = 0.4;
      c.fillRect(0, y, width, ROW - 1);
      c.globalAlpha = 1;
    }
    for (const b of row.bars) drawBar(c, b, f, y);
    if (row.deadline != null) drawDeadline(c, f, row.deadline, y);
  }
  drawLinks(c, f, bottom);
  drawHot(c, f);
  c.restore();

  if (show.today) {
    c.fillStyle = pal.accent;
    c.fillRect(Math.round(scale.x(st.today) - scrollLeft), HEAD - 6, 2, bottom - HEAD + 6);
  }
  drawAxis(c, f);
  if (show.load) drawLoad(c, f, bottom);
}
