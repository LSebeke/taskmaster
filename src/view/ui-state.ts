import type { State } from '../engine';

export type LayerLevel = 'off' | 'ghost' | 'solid';
export type LayerName = 'plan' | 'fc';
export type Axis = 'date' | 'cw';

/** Everything the View menu can switch. */
export const DEFAULT_SHOW = {
  ext: true,
  legend: true,
  today: true,
  deps: true,
  crit: true,
  cap: false,
  deadlines: true,
  pins: true,
  milestones: true,
  nonwork: true,
  grid: true,
  load: true,
  cols: true,
  conflicts: true,
  rail: true,
  status: true,
  eyes: true,
  ghost: true,
};
export type Show = typeof DEFAULT_SHOW;

export const ZOOMS = [
  { label: 'Q', ppd: 3 },
  { label: 'M', ppd: 7 },
  { label: 'W', ppd: 16 },
];

/** Update plan, open. Rows are fixed when it opens. */
export interface PlanDialog {
  rows: string[];
  ids: Set<string>;
  deep: boolean;
  name: string;
  /** Stays as it is. */
  above: string | null;
}

export interface UiState {
  focus: string | null;
  sel: string | null;
  /** Everything starts expanded, so new parents need no bookkeeping. */
  collapsed: Set<string>;
  hidden: Set<string>;
  hiddenOpen: boolean;
  /** Week whose capacity is being edited on the load strip. */
  weekEdit: number | null;
  /** Pixels per day. */
  ppd: number;
  plan: LayerLevel;
  fc: LayerLevel;
  axis: Axis;
  show: Show;
  viewOpen: boolean;
  planDlg: PlanDialog | null;
  historyOpen: boolean;
}

export const defaultUi = (): UiState => ({
  focus: null,
  sel: null,
  collapsed: new Set(),
  hidden: new Set(),
  hiddenOpen: false,
  weekEdit: null,
  ppd: 7,
  plan: 'solid',
  fc: 'ghost',
  axis: 'date',
  show: { ...DEFAULT_SHOW },
  viewOpen: false,
  planDlg: null,
  historyOpen: false,
});

/** What the chart shows at each lane. The View menu can hide the ghost without moving the levels. */
export function layers(ui: UiState): { solid: LayerName | null; ghost: LayerName | null } {
  const at = (level: LayerLevel) => (ui.plan === level ? 'plan' : ui.fc === level ? 'fc' : null);
  return { solid: at('solid'), ghost: ui.show.ghost ? at('ghost') : null };
}

/** Each level holds at most one layer, Off included, so a taken level swaps the two. */
export function setLayer(ui: UiState, layer: LayerName, level: LayerLevel): UiState {
  const other: LayerName = layer === 'plan' ? 'fc' : 'plan';
  const swap = ui[other] === level;
  const next = { ...ui, ...(swap && { [other]: ui[layer] }), [layer]: level };
  // Choosing Ghost asks to see it, whoever lands there.
  return level === 'ghost' || (swap && ui[layer] === 'ghost') ? setShow(next, 'ghost', true) : next;
}

export const setShow = (ui: UiState, key: keyof Show, on: boolean): UiState => ({ ...ui, show: { ...ui.show, [key]: on } });

/**
 * Hides everything but the top bar and one layer: the solid one, else the one on show, promoted,
 * since the ghost is hidden too and a chart without bars shares nothing.
 */
export function cleanForSharing(ui: UiState): UiState {
  const keep: LayerName = ui.plan === 'solid' || (ui.fc !== 'solid' && ui.plan === 'ghost') ? 'plan' : 'fc';
  const show = Object.fromEntries(Object.keys(DEFAULT_SHOW).map(k => [k, false])) as Show;
  return { ...ui, show, viewOpen: false, hiddenOpen: false, plan: keep === 'plan' ? 'solid' : 'off', fc: keep === 'fc' ? 'solid' : 'off' };
}

export const defaultView = (ui: UiState): UiState => ({ ...ui, show: { ...DEFAULT_SHOW }, plan: 'solid', fc: 'ghost', viewOpen: false });

export function setFocus(ui: UiState, id: string | null): UiState {
  const collapsed = new Set(ui.collapsed);
  if (id) collapsed.delete(id);
  return { ...ui, focus: id, sel: null, collapsed };
}

export const goUp = (ui: UiState, st: State): UiState => (ui.focus ? setFocus(ui, st.items[ui.focus].parent) : ui);

/** Closes what is open, then clears selection, then goes up. */
export function escape(ui: UiState, st: State): UiState {
  if (ui.weekEdit != null) return { ...ui, weekEdit: null };
  if (ui.planDlg) return { ...ui, planDlg: null };
  if (ui.historyOpen) return { ...ui, historyOpen: false };
  if (ui.viewOpen) return { ...ui, viewOpen: false };
  if (ui.hiddenOpen) return { ...ui, hiddenOpen: false };
  if (ui.sel) return { ...ui, sel: null };
  return goUp(ui, st);
}

export function toggleCollapsed(ui: UiState, id: string): UiState {
  const collapsed = new Set(ui.collapsed);
  if (!collapsed.delete(id)) collapsed.add(id);
  return { ...ui, collapsed };
}

const isInside = (st: State, id: string, ancestor: string) => {
  for (let i: string | null = id; i; i = st.items[i]?.parent ?? null) if (i === ancestor) return true;
  return false;
};

/** Display only: hidden work still schedules and counts. */
export function toggleHidden(ui: UiState, id: string, st: State): UiState {
  const hidden = new Set(ui.hidden);
  const hiding = !hidden.delete(id);
  if (hiding) hidden.add(id);
  return {
    ...ui,
    hidden,
    hiddenOpen: ui.hiddenOpen && hidden.size > 0,
    sel: hiding && ui.sel && isInside(st, ui.sel, id) ? null : ui.sel,
  };
}

/** Notes come and go under the view. */
export function pruneUi(ui: UiState, st: State): UiState {
  const gone = (id: string | null) => id != null && !st.items[id];
  const staleHidden = [...ui.hidden].some(gone);
  const dlg = ui.planDlg;
  const staleDlg = !!dlg && dlg.rows.some(gone);
  if (!gone(ui.focus) && !gone(ui.sel) && !staleHidden && !staleDlg) return ui;
  const rows = dlg?.rows.filter(id => !gone(id));
  return {
    ...ui,
    planDlg: dlg && rows?.length ? { ...dlg, rows, ids: new Set([...dlg.ids].filter(id => !gone(id))) } : null,
    focus: gone(ui.focus) ? null : ui.focus,
    sel: gone(ui.sel) ? null : ui.sel,
    hidden: staleHidden ? new Set([...ui.hidden].filter(id => !gone(id))) : ui.hidden,
  };
}
