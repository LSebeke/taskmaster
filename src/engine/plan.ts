import type { Analysis, PlanEntry, State } from './types';

export function snapshot(a: Analysis, st: State, id: string): PlanEntry {
  const b = a.by[id];
  return { start: b.start ?? st.today, end: b.end ?? st.today, hours: b.spent + b.left };
}

/** The plan changes only here. ids: rows chosen at the current level. deep: also their sub-levels.
 *  Never touches anything above. External items and anything without dates, such as drafts, are left
 *  out entirely, history included: there is nothing to freeze. Returns how many items changed. */
export function updatePlan(st: State, a: Analysis, ids: string[], deep: boolean): number {
  const set = new Set<string>();
  const walk = (i: string) => {
    if (st.items[i].kind === 'ext') return;
    if (a.by[i]?.end != null) set.add(i);
    if (deep) (a.K[i] ?? []).forEach(walk);
  };
  ids.forEach(walk);
  if (!set.size) return 0;
  (st.planHistory ||= []).push({
    day: st.today,
    ids: [...set],
    before: Object.fromEntries([...set].map(i => [i, st.plan[i]])),
  });
  for (const i of set) st.plan[i] = snapshot(a, st, i);
  return set.size;
}
