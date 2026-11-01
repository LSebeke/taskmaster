import type { State } from '../engine';

export type LayerLevel = 'off' | 'ghost' | 'solid';
export type LayerName = 'plan' | 'fc';
export type Axis = 'date' | 'cw';
export type RailTab = 'overview' | 'todo';

/** Everything the View menu can switch. The menu itself comes with the plan layer. */
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
};
export type Show = typeof DEFAULT_SHOW;

export const ZOOMS = [
  { label: 'Q', ppd: 3 },
  { label: 'M', ppd: 7 },
  { label: 'W', ppd: 16 },
];

export interface UiState {
  focus: string | null;
  sel: string | null;
  /** Everything starts expanded, so new parents need no bookkeeping. */
  collapsed: Set<string>;
  hidden: Set<string>;
  hiddenOpen: boolean;
  /** Week whose capacity is being edited on the load strip. */
  weekEdit: number | null;
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
}

export const defaultUi = (): UiState => ({
  focus: null,
  sel: null,
  collapsed: new Set(),
  hidden: new Set(),
  hiddenOpen: false,
  weekEdit: null,
  tab: 'overview',
  todoAll: false,
  todoOpen: new Set(),
  ppd: 7,
  plan: 'solid',
  fc: 'ghost',
  axis: 'date',
  show: { ...DEFAULT_SHOW },
});

export function layers(ui: UiState): { solid: LayerName | null; ghost: LayerName | null } {
  const at = (level: LayerLevel) => (ui.plan === level ? 'plan' : ui.fc === level ? 'fc' : null);
  return { solid: at('solid'), ghost: at('ghost') };
}

export function setFocus(ui: UiState, id: string | null): UiState {
  const collapsed = new Set(ui.collapsed);
  if (id) collapsed.delete(id);
  return { ...ui, focus: id, sel: null, collapsed };
}

export const goUp = (ui: UiState, st: State): UiState => (ui.focus ? setFocus(ui, st.items[ui.focus].parent) : ui);

/** Closes what is open, then clears selection, then goes up. */
export function escape(ui: UiState, st: State): UiState {
  if (ui.weekEdit != null) return { ...ui, weekEdit: null };
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
  if (!gone(ui.focus) && !gone(ui.sel) && !staleHidden) return ui;
  return {
    ...ui,
    focus: gone(ui.focus) ? null : ui.focus,
    sel: gone(ui.sel) ? null : ui.sel,
    hidden: staleHidden ? new Set([...ui.hidden].filter(id => !gone(id))) : ui.hidden,
  };
}
