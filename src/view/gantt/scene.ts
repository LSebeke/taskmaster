import type { Analysis, Day, State } from '../../engine';
import type { Row } from '../rows';
import { layers, type LayerName, type UiState } from '../ui-state';

/** Lanes inside a row, in pixels. Days stay days, so zooming needs no new scene. */
const GHOST_TOP = 21;
const GHOST_H = 4;
const SOLID_TOP = 6;
const SOLID_H = 12;
const GROUP_TOP = 9;
const GROUP_H = 7;
const EXT_TOP = 6;
const EXT_H = 16;
const MS_SOLID_Y = 11;
const MS_SOLID_R = 6;
const MS_GHOST_Y = 23;
const MS_GHOST_R = 4;
const LANE_SOLID = 12;
const LANE_GHOST = 23;
const LANE_EXT = 14;
const SLACK = 3;
const MS_SLACK = 8;

export interface Bar {
  id: string;
  kind: 'bar' | 'ms' | 'ext';
  layer: LayerName;
  role: 'solid' | 'ghost';
  /** Left edge of the first day, right edge of the last. For a milestone, the day itself. */
  startDay: Day;
  endDay: Day;
  top: number;
  h: number;
  /** Project colour, 1 to 8. 0 is neutral. */
  color: number;
  /** Done share to fill. */
  pct: number;
  crit: boolean;
  faded: boolean;
  /** Pinned edges, as chart days. */
  pinS?: Day;
  pinE?: Day;
  /** Hit zone inside the row. */
  y0: number;
  y1: number;
  slack: number;
}

export interface SceneRow {
  id: string;
  section: boolean;
  bars: Bar[];
  deadline?: Day;
}

export interface Link {
  a: string;
  b: string;
  /** Row indexes. */
  i0: number;
  i1: number;
  startDay: Day;
  endDay: Day;
  /** Height inside each row. */
  y0: number;
  y1: number;
  tone: 'axis' | 'crit';
  dashed: boolean;
  width: number;
}

export interface Scene {
  rows: SceneRow[];
  links: Link[];
  /** Project colour per root, shared with the load strip. */
  rootColors: Map<string, number>;
}

export const projectRoots = (st: State, a: Analysis): string[] => (a.kids[''] ?? []).filter(i => st.items[i].kind !== 'ext');

function rootOfCached(st: State, id: string, memo: Map<string, string>): string {
  const known = memo.get(id);
  if (known) return known;
  const parent = st.items[id].parent;
  const root = parent ? rootOfCached(st, parent, memo) : id;
  memo.set(id, root);
  return root;
}

function barsOf(st: State, a: Analysis, id: string, color: number, ui: UiState): Bar[] {
  const it = st.items[id];
  const b = a.results[id];
  if (!b) return [];
  const { solid, ghost } = layers(ui);
  const group = !!a.kids[id];
  const fc = b.start != null && b.end != null ? { start: b.start, end: b.end } : null;
  const plan = st.plan[id] ?? null;
  const dates = (l: LayerName) => (l === 'fc' ? fc : plan);
  const common = { id, color, pct: Math.max(0, Math.min(1, b.pct)), faded: false };

  if (it.kind === 'ext') {
    if (!fc) return [];
    return [
      {
        ...common,
        kind: 'ext',
        layer: 'fc',
        role: 'solid',
        color: 0,
        startDay: fc.start,
        endDay: fc.end + 1,
        top: EXT_TOP,
        h: EXT_H,
        crit: ui.show.crit && b.crit && !b.done,
        faded: b.done,
        y0: EXT_TOP - SLACK,
        y1: EXT_TOP + EXT_H + SLACK,
        slack: SLACK,
      },
    ];
  }

  const out: Bar[] = [];
  if (it.kind === 'ms') {
    if (!ui.show.milestones) return [];
    const add = (l: LayerName | null, role: Bar['role'], y: number, r: number) => {
      const at = l && dates(l);
      if (!l || !at) return;
      out.push({ ...common, kind: 'ms', layer: l, role, startDay: at.end, endDay: at.end, top: y, h: r, crit: false, y0: y - MS_SLACK, y1: y + MS_SLACK, slack: MS_SLACK });
    };
    add(ghost, 'ghost', MS_GHOST_Y, MS_GHOST_R);
    add(solid, 'solid', MS_SOLID_Y, MS_SOLID_R);
    return out;
  }

  const crit = ui.show.crit && b.crit && !b.done && !group;
  const pins = (l: LayerName) =>
    l === 'fc' && !group && ui.show.pins ? { pinS: it.pinS ?? undefined, pinE: it.pinE != null ? it.pinE + 1 : undefined } : {};

  const ghostAt = ghost && dates(ghost);
  if (ghost && ghostAt) {
    out.push({
      ...common,
      ...pins(ghost),
      kind: 'bar',
      layer: ghost,
      role: 'ghost',
      startDay: ghostAt.start,
      endDay: Math.max(ghostAt.start, ghostAt.end) + 1,
      top: GHOST_TOP,
      h: GHOST_H,
      crit: ghost === 'fc' && crit,
      y0: GHOST_TOP - 4,
      y1: GHOST_TOP + 8,
      slack: SLACK,
    });
  }
  const solidAt = solid && dates(solid);
  if (solid && solidAt) {
    const top = group ? GROUP_TOP : SOLID_TOP;
    const h = group ? GROUP_H : SOLID_H;
    out.push({
      ...common,
      ...pins(solid),
      kind: 'bar',
      layer: solid,
      role: 'solid',
      startDay: solidAt.start,
      endDay: Math.max(solidAt.start, solidAt.end) + 1,
      top,
      h,
      crit: solid === 'fc' && crit,
      y0: top - SLACK,
      y1: top + h + SLACK,
      slack: SLACK,
    });
  }
  return out;
}

function buildLinks(st: State, a: Analysis, rows: Row[], ui: UiState): Link[] {
  const pos = new Map<string, number>();
  rows.forEach((r, i) => {
    if (!r.section) pos.set(r.id, i);
  });
  const { solid, ghost } = layers(ui);
  // The layer links attach to: the forecast, or the plan with no forecast on show.
  const layer = solid === 'fc' || ghost === 'fc' ? 'fc' : solid ?? ghost;
  if (!layer) return [];
  const lane = solid === layer ? LANE_SOLID : LANE_GHOST;
  const isExt = (id: string) => st.items[id].kind === 'ext';
  const unseen = (id: string) => !ui.show.milestones && st.items[id].kind === 'ms';
  const dates = (id: string) => (layer === 'fc' || isExt(id) ? a.results[id] : st.plan[id]);
  const yOf = (id: string) => (isExt(id) ? LANE_EXT : lane);
  const links: Link[] = [];
  const add = (from: string, to: string, tone: Link['tone'], dashed: boolean, width: number) => {
    const i0 = pos.get(from);
    const i1 = pos.get(to);
    if (i0 == null || i1 == null || unseen(from) || unseen(to)) return;
    const end = dates(from)?.end;
    const start = dates(to)?.start;
    if (end == null || start == null) return;
    links.push({ a: from, b: to, i0, i1, startDay: end + 1, endDay: start, y0: yOf(from), y1: yOf(to), tone, dashed, width });
  };

  // Only dep links replace a plain link: capacity links are off by default, and it would vanish with them.
  const critical = new Set(a.links.filter(l => l.kind === 'dep').map(l => `${l.a}>${l.b}`));
  if (ui.show.deps) {
    for (const r of rows) {
      if (r.section) continue;
      const it = st.items[r.id];
      for (const p of it.deps ?? []) {
        if (ui.show.crit && critical.has(`${p}>${r.id}`)) continue;
        const end = a.results[p]?.end;
        const late = it.pinS != null && end != null && (isExt(p) ? end >= it.pinS : end > it.pinS);
        add(p, r.id, late ? 'crit' : 'axis', false, 1);
      }
    }
  }
  for (const l of a.links) {
    if (l.kind === 'dep' ? ui.show.crit : ui.show.cap) add(l.a, l.b, 'crit', l.kind === 'cap', 1.5);
  }
  return links;
}

/** Geometry of the whole chart. Rebuilt when data or rows change, never on scroll or zoom. */
export function buildScene(st: State, a: Analysis, rows: Row[], ui: UiState): Scene {
  const roots = projectRoots(st, a);
  const rootColors = new Map(roots.map((r, i) => [r, (i % 8) + 1]));
  const memo = new Map<string, string>();
  return {
    rows: rows.map(r => {
      if (r.section) return { id: r.id, section: true, bars: [] };
      const color = rootColors.get(rootOfCached(st, r.id, memo)) ?? 0;
      const deadline = ui.show.deadlines ? st.items[r.id].deadline : undefined;
      return { id: r.id, section: false, bars: barsOf(st, a, r.id, color, ui), deadline };
    }),
    links: buildLinks(st, a, rows, ui),
    rootColors,
  };
}
