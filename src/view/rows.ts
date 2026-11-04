import { effDeps, leavesOf, type Analysis, type State } from '../engine';
import type { UiState } from './ui-state';

export const ROW = 30;
/** Height of the column head and of the time axis. */
export const HEAD = 40;
export const LOADH = 62;

export interface Row {
  id: string;
  depth: number;
  /** The External section's header. */
  section?: boolean;
}

export type Tone = 'good' | 'crit' | 'muted' | 'plain';

export interface Marker {
  text: string;
  tone: Tone;
  title?: string;
}

export interface RowView {
  id: string;
  depth: number;
  title: string;
  group: boolean;
  isDone: boolean;
  conflict: boolean;
  collapsed: boolean;
  /** Milestone or external sign, in place of the collapse button. */
  glyph: string | null;
  /** Children can go in it. */
  canAdd: boolean;
  /** Done %, blank for milestones and externals. */
  done: string;
  marker: Marker;
}

const SECTION = '__ext';

/** What the column and the chart both show, top to bottom. */
export function buildRows(st: State, a: Analysis, ui: UiState): Row[] {
  const out: Row[] = [];
  const isExt = (id: string) => st.items[id].kind === 'ext';
  const walk = (ids: string[] | undefined, depth: number) => {
    for (const id of ids ?? []) {
      if (ui.hidden.has(id)) continue;
      out.push({ id, depth });
      if (a.kids[id] && !ui.collapsed.has(id)) walk(a.kids[id], depth + 1);
    }
  };
  walk((a.kids[ui.focus ?? ''] ?? []).filter(i => !isExt(i)), 0);

  if (ui.show.ext) {
    let ext = (a.kids[''] ?? []).filter(isExt).filter(i => !ui.hidden.has(i));
    if (ui.focus) {
      const used = new Set(leavesOf(st, ui.focus, a.kids).flatMap(l => effDeps(st, l, a.kids)));
      ext = ext.filter(i => used.has(i));
    }
    if (ext.length) {
      out.push({ id: SECTION, depth: 0, section: true });
      for (const id of ext.sort((x, y) => st.items[x].pinS! - st.items[y].pinS!)) out.push({ id, depth: 0 });
    }
  }
  return out;
}

/** Rows to keep mounted: what is on screen, plus a margin. */
export function rowWindow(scrollTop: number, height: number, count: number): [number, number] {
  return [Math.max(0, Math.floor(scrollTop / ROW) - 2), Math.min(count, Math.ceil((scrollTop + height) / ROW) + 2)];
}

/** All hidden rows, wherever they are: under a collapsed parent or outside the focus too. */
export function hiddenList(st: State, hidden: Set<string>): { id: string; title: string; path: string }[] {
  return [...hidden].flatMap(id => {
    const it = st.items[id];
    if (!it) return [];
    const path: string[] = [];
    for (let p = it.parent; p; p = st.items[p].parent) path.unshift(st.items[p].title);
    return [{ id, title: it.title, path: path.join(' › ') }];
  });
}

export function vsPlan(st: State, a: Analysis, id: string): Marker {
  const b = a.results[id];
  if (st.items[id].kind === 'ext') return { text: b?.done ? 'past' : 'ext', tone: 'plain' };
  if (b.draft || (a.kids[id] && b.end == null)) return { text: '○ no hrs', tone: 'muted', title: 'Add hours or children to schedule it' };
  if (!st.plan[id]) return { text: '● new', tone: 'muted', title: 'Not in the plan yet' };
  if (b.overDeadline) return { text: `▲ ${b.overDeadline}d`, tone: 'crit', title: 'Past deadline' };
  if (b.shift! > 0) return { text: `▲ +${b.shift}d`, tone: 'crit', title: 'Behind plan' };
  if (b.shift! < 0) return { text: `▼ ${b.shift}d`, tone: 'good', title: 'Ahead of plan' };
  return { text: b.done ? '✓ done' : '✓ 0d', tone: 'good' };
}

export function rowView(st: State, a: Analysis, row: Row, conflicts: Set<string | null>, ui: UiState): RowView {
  const { id, depth } = row;
  const it = st.items[id];
  const b = a.results[id];
  const group = !!a.kids[id];
  return {
    id,
    depth,
    title: it.title,
    group,
    isDone: !!b?.done,
    conflict: ui.show.conflicts && conflicts.has(id),
    collapsed: ui.collapsed.has(id),
    glyph: it.kind === 'ms' ? '◆' : it.kind === 'ext' ? '⛭' : null,
    canAdd: it.kind === 'item',
    done: it.kind === 'item' ? `${Math.round((b?.pct ?? 0) * 100)}%` : '',
    marker: vsPlan(st, a, id),
  };
}
