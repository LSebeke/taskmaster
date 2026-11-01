import { workDays } from './calendar';
import { effDeps, kids, leavesOf, rootOf } from './graph';
import { EPS, schedule, type Schedule } from './schedule';
import type { Day, KidsMap, ScheduleOptions, State } from './types';

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
export function finishOf(st: State, root: string, opt: ScheduleOptions = {}): Day | null {
  const { C, r } = schedule(st, opt);
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
  const projects = [...new Set(users.map(i => rootOf(st, i)))].map(root => {
    const a = finishOf(st, root);
    const b = finishOf(st, root, { exclude: new Set([id]) });
    const later = a != null && b != null && a !== Infinity && b !== Infinity && a > b;
    return { root, days: later ? workDays(b + 1, a, s) : 0 };
  });
  return { users, items, projects };
}

/** Forecast with hours left inflated by the historic estimate ratio. */
export const adjusted = (st: State, root: string, ratio: number): Day | null => {
  const leaves = new Set(leavesOf(st, root));
  return finishOf(st, root, { scale: id => (leaves.has(id) ? ratio : 1) });
};
