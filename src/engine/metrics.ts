import { workDays } from './calendar';
import { effDeps, kids, leavesOf, rootOf } from './graph';
import { EPS, schedule, type Schedule } from './schedule';
import type { Analysis, Day, KidsMap, ScheduleOptions, State } from './types';

/** Estimate ratio: actual over estimate on finished tasks. */
export function accuracy(st: State, root: string, K: KidsMap = kids(st)): { ratio: number; sample: number } | null {
  let actual = 0;
  let estimate = 0;
  for (const l of leavesOf(st, root, K)) {
    const it = st.items[l];
    if (it.est && (it.left ?? 0) <= EPS && it.kind !== 'ms') {
      actual += it.spent ?? 0;
      estimate += it.est;
    }
  }
  return estimate > 0 ? { ratio: actual / estimate, sample: estimate } : null;
}

/** Project finish. Null with nothing scheduled, Infinity if a task never finishes. */
export const finishOf = (st: State, root: string, opt: ScheduleOptions = {}): Day | null => finishIn(schedule(st, opt), root);

function finishIn({ C, r }: Schedule, root: string): Day | null {
  let m: Day | null = null;
  C.T.forEach((t, i) => {
    if (t.root !== root) return;
    if (r.fin[i] < 0) m = Infinity;
    else if (m !== Infinity) m = Math.max(m ?? -Infinity, r.fin[i]);
  });
  return m;
}

export interface MvpSignal {
  deadline: Day | undefined;
  full: Day | null;
  noCould: Day | null;
  noCouldH: number;
  mustOnly: Day | null;
  mustOnlyH: number;
}

/** Reruns the schedule without could-haves, then also without should-haves. */
export function mvp(st: State, root: string): MvpSignal {
  const leaves = leavesOf(st, root);
  const left = (l: string) => st.items[l].left ?? 0;
  const pick = (scopes: string[]) =>
    new Set(leaves.filter(l => scopes.includes(st.items[l].scope!) && left(l) > 0));
  const hours = (set: Set<string>) => [...set].reduce((a, l) => a + left(l), 0);
  const coulds = pick(['could']);
  const shoulds = pick(['could', 'should']);
  return {
    deadline: st.items[root].deadline,
    full: finishOf(st, root),
    noCould: finishOf(st, root, { exclude: coulds }),
    noCouldH: hours(coulds),
    mustOnly: finishOf(st, root, { exclude: shoulds }),
    mustOnlyH: hours(shoulds),
  };
}

export type MvpVerdict = 'full' | 'no-could' | 'must-only' | 'miss';

/** Null without a deadline or without anything scheduled. An option with no work left finishes nothing, so it makes it. */
export function mvpVerdict(m: MvpSignal): MvpVerdict | null {
  const { deadline } = m;
  if (deadline == null || m.full == null) return null;
  const makes = (d: Day | null) => d == null || d <= deadline;
  if (makes(m.full)) return 'full';
  if (makes(m.noCould)) return 'no-could';
  return makes(m.mustOnly) ? 'must-only' : 'miss';
}

const NEXT_UP = 5;

/** Unblocked tasks in tier order, critical first inside a level. Scope limits it to one item's tasks. */
export function nextUp(st: State, a: Analysis, scope: string | null, limit = NEXT_UP): string[] {
  const inside = scope ? new Set(leavesOf(st, scope, a.kids)) : null;
  const clear = (id: string) => effDeps(st, id, a.kids).every(p => p === id || a.results[p]?.done || a.results[p]?.draft);
  const crit = (id: string) => (a.results[id].crit ? 0 : 1);
  return st.tiers
    .flatMap(level => level.filter(id => st.items[id] && (!inside || inside.has(id)) && !a.results[id]?.done && clear(id)).sort((x, y) => crit(x) - crit(y)))
    .slice(0, limit);
}

const startIn = (S: Schedule, id: string): Day | null => {
  const k = S.C.ix[id];
  const x = S.r.first[k] >= 0 ? S.r.first[k] : S.r.fin[k];
  return x >= 0 ? x : null;
};

/** What an external item costs: blocked items' starts and project finishes, with and without it. */
export function externalImpact(st: State, id: string) {
  const K = kids(st);
  const s = st.settings;
  const users = Object.keys(st.items).filter(i => !K[i] && st.items[i].kind !== 'ext' && effDeps(st, i, K).includes(id));
  const withIt = schedule(st);
  const without = schedule(st, { exclude: new Set([id]) });
  const items = users
    .map(i => {
      const a = startIn(withIt, i);
      const b = startIn(without, i);
      return { id: i, start: a, days: a != null && b != null && a > b ? workDays(b + 1, a, s) : 0 };
    })
    .sort((x, y) => y.days - x.days);
  const later = (root: string) => {
    const a = finishIn(withIt, root);
    const b = finishIn(without, root);
    return a != null && b != null && a !== Infinity && b !== Infinity && a > b ? workDays(b + 1, a, s) : 0;
  };
  const blocked = new Set(users.map(i => rootOf(st, i)));
  // A project with nothing blocked still slips when delayed work takes its hours.
  const others = [...new Set(withIt.C.T.map(t => t.root))].filter(root => !blocked.has(root) && root !== id && later(root) > 0);
  const projects = [...blocked, ...others].map(root => ({ root, days: later(root) }));
  return { users, items, projects };
}

/** Forecast with hours left inflated by the historic estimate ratio. */
export const adjusted = (st: State, root: string, ratio: number): Day | null => {
  const leaves = new Set(leavesOf(st, root));
  return finishOf(st, root, { scale: id => (leaves.has(id) ? ratio : 1) });
};
