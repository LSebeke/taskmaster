import type { Analysis, Day, PlanEntry, State } from '../engine';
import { noteName } from './format';
import type { PlanDialog, UiState } from './ui-state';

export interface PlanTarget {
  rows: string[];
  /** For the button: names the target. */
  name: string;
  /** Stays as it is: the level above the rows. */
  above: string | null;
}

/** A selected row, else the rows at the current level. External items are never a target. */
export function planTarget(st: State, a: Analysis, ui: UiState): PlanTarget {
  const { sel, focus } = ui;
  if (sel && st.items[sel] && st.items[sel].kind !== 'ext') return { rows: [sel], name: st.items[sel].title, above: st.items[sel].parent };
  const rows = (a.kids[focus ?? ''] ?? []).filter(i => st.items[i].kind !== 'ext');
  // Focused, the rows change and the focused item does not. The name must not suggest otherwise.
  return { rows, name: focus ? `under ${st.items[focus].title}` : 'all projects', above: focus };
}

const plannable = (a: Analysis, id: string) => a.results[id]?.end != null;

export function openPlan(ui: UiState, st: State, a: Analysis): UiState {
  const { rows, name, above } = planTarget(st, a, ui);
  return { ...ui, viewOpen: false, historyOpen: false, planDlg: { rows, ids: new Set(rows.filter(i => plannable(a, i))), deep: true, name, above } };
}

export function togglePlanRow(ui: UiState, id: string): UiState {
  if (!ui.planDlg) return ui;
  const ids = new Set(ui.planDlg.ids);
  if (!ids.delete(id)) ids.add(id);
  return { ...ui, planDlg: { ...ui.planDlg, ids } };
}

export const setPlanDeep = (ui: UiState, deep: boolean): UiState => (ui.planDlg ? { ...ui, planDlg: { ...ui.planDlg, deep } } : ui);

export interface PlanRow {
  id: string;
  title: string;
  oldEnd: Day | undefined;
  newEnd: Day | null;
  checked: boolean;
  /** Has dates to freeze. */
  plannable: boolean;
  group: boolean;
}

export const planRows = (st: State, a: Analysis, dlg: PlanDialog): PlanRow[] =>
  dlg.rows.map(id => ({
    id,
    title: st.items[id].title,
    oldEnd: st.plan[id]?.end,
    newEnd: a.results[id]?.end ?? null,
    checked: dlg.ids.has(id),
    plannable: plannable(a, id),
    group: !!a.kids[id],
  }));

export interface HistoryRow {
  id: string;
  title: string;
  before: PlanEntry | undefined;
  after: PlanEntry | undefined;
}

export interface HistoryEntry {
  day: Day;
  rows: HistoryRow[];
}

/**
 * Newest first. Each update stores only what it replaced, so the value it set is what the next
 * update of that item replaced, or the plan today. Items may be gone since, so ids are not trusted.
 */
export function historyView(st: State): HistoryEntry[] {
  const seen = new Map<string, PlanEntry | undefined>();
  return (st.planHistory ?? [])
    .slice()
    .reverse()
    .map(h => ({
      day: h.day,
      rows: h.ids.map(id => {
        const after = seen.has(id) ? seen.get(id) : st.plan[id];
        seen.set(id, h.before[id]);
        return { id, title: st.items[id]?.title ?? noteName(id), before: h.before[id], after };
      }),
    }));
}
