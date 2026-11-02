import type { ItemKind, KidsMap, NewItem, State } from '../engine';
import { mover } from '../store/ports';

export type LayerLevel = 'off' | 'ghost' | 'solid';
export type LayerName = 'plan' | 'fc';
export type Axis = 'date' | 'cw';
export type RailTab = 'overview' | 'todo';

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

/** The add form. Its text fields live in the form; these outlast an Add, or follow a rename. */
export interface FormState {
  kind: ItemKind;
  parent: string | null;
  /** The item just added, which the next may depend on. */
  last: string | null;
  added: string[];
  /** A new number is a new form. */
  nonce: number;
}

export interface UiState {
  form: FormState | null;
  focus: string | null;
  sel: string | null;
  /** Everything starts expanded, so new parents need no bookkeeping. */
  collapsed: Set<string>;
  hidden: Set<string>;
  hiddenOpen: boolean;
  /** Week whose capacity is being edited on the load strip. */
  weekEdit: number | null;
  /** Forms opened so far. */
  nonces: number;
  tab: RailTab;
  /** The overall to-do list, even with a project focused. */
  todoAll: boolean;
  /** Tasks expanded in the to-do lists. */
  todoOpen: Set<string>;
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
  form: null,
  focus: null,
  sel: null,
  collapsed: new Set(),
  hidden: new Set(),
  hiddenOpen: false,
  weekEdit: null,
  nonces: 0,
  tab: 'overview',
  todoAll: false,
  todoOpen: new Set(),
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

export const goUp = (ui: UiState, st: State): UiState => (ui.focus ? setFocus(ui, st.items[ui.focus]?.parent ?? null) : ui);

/** `in`: a chosen parent. Otherwise the selected parent, else the selected item's parent, else the focus. */
export function openForm(ui: UiState, st: State, K: KidsMap, where: 'project' | 'item' | { in: string }): UiState {
  const near = ui.sel ? (K[ui.sel] ? ui.sel : (st.items[ui.sel]?.parent ?? null)) : null;
  const parent = where === 'project' ? null : where === 'item' ? (near ?? ui.focus) : where.in;
  const form = { kind: 'item' as const, parent, last: null, added: [], nonce: (ui.form?.nonce ?? ui.nonces) + 1 };
  return { ...ui, form, nonces: form.nonce, tab: 'overview', show: { ...ui.show, rail: true } };
}

/** The form after adding `id`: it stays open for the next item, and the new one stays in sight. */
export function afterAdd(ui: UiState, st: State, n: NewItem, id: string): UiState {
  const it = st.items[id];
  if (!ui.form || !it) return ui;
  const project = n.kind !== 'ext' && !n.parent;
  const external = n.kind === 'ext';
  const collapsed = new Set(ui.collapsed);
  if (it.parent) collapsed.delete(it.parent);
  return {
    ...ui,
    collapsed,
    // New work outside the focus would be out of sight.
    focus: ui.focus && !external && !isInside(st, id, ui.focus) ? null : ui.focus,
    form: { ...ui.form, parent: project ? id : ui.form.parent, last: project || external ? null : id, added: [...ui.form.added, it.title] },
  };
}

/** Closes what is open, then clears selection, then goes up. */
export function escape(ui: UiState, st: State): UiState {
  if (ui.form) return { ...ui, form: null };
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

export function toggleTodoOpen(ui: UiState, id: string): Pick<UiState, 'todoOpen'> {
  const todoOpen = new Set(ui.todoOpen);
  if (!todoOpen.delete(id)) todoOpen.add(id);
  return { todoOpen };
}

export const isInside = (st: State, id: string, ancestor: string) => {
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

/** A note or folder was renamed. Everything the view holds is keyed by path. */
export function rekeyUi(ui: UiState, from: string, to: string): UiState {
  const move = mover(from, to);
  const moveNull = (p: string | null) => p && move(p);
  const moveSet = (s: Set<string>) => new Set([...s].map(move));
  const { form, planDlg } = ui;
  return {
    ...ui,
    focus: moveNull(ui.focus),
    sel: moveNull(ui.sel),
    collapsed: moveSet(ui.collapsed),
    hidden: moveSet(ui.hidden),
    todoOpen: moveSet(ui.todoOpen),
    form: form && { ...form, parent: moveNull(form.parent), last: moveNull(form.last) },
    planDlg: planDlg && { ...planDlg, rows: planDlg.rows.map(move), ids: moveSet(planDlg.ids), above: moveNull(planDlg.above) },
  };
}

/** Notes come and go under the view: an id the state does not have counts as none. Unchanged, returns `ui` itself. */
export function pruneUi(ui: UiState, st: State): UiState {
  const gone = (id: string | null) => id != null && !st.items[id];
  const present = (s: Set<string>) => ([...s].some(gone) ? new Set([...s].filter(id => !gone(id))) : s);
  if (ui.form && (gone(ui.form.parent) || gone(ui.form.last))) {
    ui = { ...ui, form: { ...ui.form, parent: gone(ui.form.parent) ? null : ui.form.parent, last: gone(ui.form.last) ? null : ui.form.last } };
  }
  const hidden = present(ui.hidden);
  const collapsed = present(ui.collapsed);
  const todoOpen = present(ui.todoOpen);
  const dlg = ui.planDlg;
  const staleDlg = !!dlg && dlg.rows.some(gone);
  if (!gone(ui.focus) && !gone(ui.sel) && hidden === ui.hidden && collapsed === ui.collapsed && todoOpen === ui.todoOpen && !staleDlg) return ui;
  const rows = dlg?.rows.filter(id => !gone(id));
  return {
    ...ui,
    planDlg: dlg && rows?.length ? { ...dlg, rows, ids: new Set([...dlg.ids].filter(id => !gone(id))) } : null,
    focus: gone(ui.focus) ? null : ui.focus,
    sel: gone(ui.sel) ? null : ui.sel,
    hidden,
    collapsed,
    todoOpen,
  };
}
