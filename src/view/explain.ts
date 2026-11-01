import { effDeps, leavesOf, workDays, type Analysis, type ItemResult, type State } from '../engine';
import { fmtD, h1 } from './format';

/** Unfinished work this item still waits for, latest first. Drafts are ignored by the scheduler, so here too. */
function waitingOn(st: State, a: Analysis, id: string): string | undefined {
  return effDeps(st, id, a.K)
    .filter(p => p !== id && !a.by[p]?.done && !a.by[p]?.draft)
    .sort((x, y) => (a.by[y].end ?? Infinity) - (a.by[x].end ?? Infinity))[0];
}

const waitName = (st: State, id: string) => {
  const it = st.items[id];
  return it.kind === 'ext' ? `${it.title} (external, ends ${fmtD(it.pinE)})` : it.title;
};

/** Plain-language reason for an item's dates. */
export function why(st: State, a: Analysis, id: string): string {
  const b = a.by[id];
  const it = st.items[id];
  if (it.kind === 'ext') return `External: ${fmtD(it.pinS)} to ${fmtD(it.pinE)}. No project hours.`;
  if (b.draft) return 'Not scheduled. Give it hours, or add items inside it.';
  if (it.kind === 'ms') {
    if (it.pinE != null) return `Pinned to ${fmtD(it.pinE)}.`;
    const w = waitingOn(st, a, id);
    if (w) return `Lands when ${waitName(st, w)} finishes.`;
    return b.done ? `Passed ${fmtD(b.end)}.` : 'Nothing to wait for, so it lands today.';
  }
  if (b.done) return `Finished ${fmtD(it.doneOn ?? b.end)}.`;
  if (it.pinS != null && it.pinE != null) {
    const days = Math.max(1, workDays(Math.max(it.pinS, st.today), it.pinE, st.settings));
    return `Both ends pinned. Constant burn of ${h1(b.left / days)}h/day is reserved from capacity.`;
  }
  if (it.pinE != null) return `End pinned. Latest start that still makes it: ${fmtD(a.rel[id])}, given what runs in parallel.`;
  if (it.pinS != null) return 'Start pinned. End follows from hours and what runs in parallel.';
  if (b.idleBy && b.idleBy !== id) return `Blocked by capacity: ${st.items[b.idleBy].title} takes the hours first.`;
  const w = waitingOn(st, a, id);
  return w ? `Waits for ${waitName(st, w)}.` : 'Free to run now.';
}

/** Hover text: title first, then what the rail would say. */
export function tooltipLines(st: State, a: Analysis, id: string): string[] {
  const b = a.by[id];
  const it = st.items[id];
  const plan = st.plan[id];
  const lines = [it.title, `Forecast ${fmtD(b.start)} → ${fmtD(b.end)}`];
  if (plan) lines.push(`Plan ${fmtD(plan.start)} → ${fmtD(plan.end)}`);
  if (it.kind === 'item') lines.push(`${h1(b.spent)}h spent, ${h1(b.left)}h left (${Math.round(b.pct * 100)}%)`);
  if (it.kind !== 'ms' && !a.K[id]) lines.push(why(st, a, id));
  return lines;
}

export interface Status {
  tone: 'crit' | 'warn' | 'good' | 'plain';
  title: string;
  sub?: string;
}

export function statusOf(st: State, a: Analysis, id: string): Status {
  const b = a.by[id];
  const it = st.items[id];
  const plan = st.plan[id];
  if (b.end == null) return { tone: 'plain', title: 'Not scheduled yet', sub: 'Give it hours or add items inside it.' };
  if (b.overDeadline) return { tone: 'crit', title: `▲ Past deadline by ${b.overDeadline} working days`, sub: `Forecast ${fmtD(b.end)}, deadline ${fmtD(it.deadline)}` };
  if (b.done) return { tone: 'good', title: '✓ Done', sub: `Finished ${fmtD(b.end)}` };
  if (b.shift! > 0) return { tone: 'warn', title: `▲ ${b.shift} working days behind plan`, sub: `Plan ends ${fmtD(plan?.end)}, forecast ${fmtD(b.end)}` };
  if (!plan) return { tone: 'warn', title: '● Not in the plan yet', sub: `Forecast ${fmtD(b.end)}. Update plan to include it.` };
  const deadline = it.deadline != null ? `, deadline ${fmtD(it.deadline)}` : '';
  return { tone: 'good', title: '✓ Inside the plan', sub: `Forecast ${fmtD(b.end)}${deadline}` };
}

function subtree(a: Analysis, id: string): string[] {
  return [id, ...(a.K[id] ?? []).flatMap(c => subtree(a, c))];
}

/** Items the forecast has and the plan lacks, parents included. Externals never have a plan entry, and drafts have no dates. */
export const countNotInPlan = (st: State, a: Analysis, scope: string | null): number =>
  (scope ? subtree(a, scope) : Object.keys(st.items)).filter(i => !st.plan[i] && a.by[i]?.end != null && st.items[i].kind !== 'ext').length;

/** Child plans that outgrew this one, or null. */
export function planGapText({ planGap, planGapH }: Pick<ItemResult, 'planGap' | 'planGapH'>): string | null {
  const parts = [planGap ? `${planGap} working day${planGap > 1 ? 's' : ''}` : '', planGapH ? `${h1(planGapH)}h` : ''].filter(Boolean);
  return parts.length ? `▲ Sub-level plans outgrew this plan by ${parts.join(' and ')}.` : null;
}

export function upcomingExternals(st: State, a: Analysis, scope: string | null): string[] {
  const used = scope ? new Set(leavesOf(st, scope, a.K).flatMap(l => effDeps(st, l, a.K))) : null;
  return (a.K[''] ?? [])
    .filter(i => st.items[i].kind === 'ext' && !a.by[i]?.done && (!used || used.has(i)))
    .sort((x, y) => st.items[x].pinS! - st.items[y].pinS!);
}
