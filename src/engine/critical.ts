import type { Schedule } from './schedule';
import type { ChainLink, KidsMap, State } from './types';

/** Per project, walk back from the last-finishing task through capacity and dependency links. */
export function criticalChains(st: State, S: Schedule, K: KidsMap) {
  const { C, r } = S;
  const crit: Record<string, Set<string>> = {};
  const links: ChainLink[] = [];
  for (const root of (K[''] ?? []).filter(i => st.items[i].kind !== 'ext')) {
    let last = -1;
    let lastF = -1;
    C.T.forEach((t, i) => {
      if (t.root === root && !t.ext && r.fin[i] >= st.today && r.fin[i] > lastF) {
        lastF = r.fin[i];
        last = i;
      }
    });
    const seen = new Set<number>();
    for (let i = last; i >= 0 && !seen.has(i); ) {
      seen.add(i);
      (crit[C.T[i].id] ||= new Set()).add(root);
      const t = C.T[i];
      if (r.idleDay[i] >= 0 && r.idleBy[i] >= 0 && r.idleBy[i] !== i) {
        links.push({ a: C.T[r.idleBy[i]].id, b: t.id, kind: 'cap' });
        i = r.idleBy[i];
        continue;
      }
      let p = -1;
      let pf = -1;
      for (const q of t.preds) {
        if (r.fin[q] > pf) {
          pf = r.fin[q];
          p = q;
        }
      }
      if (p < 0 || pf < st.today) break;
      links.push({ a: C.T[p].id, b: t.id, kind: 'dep' });
      i = p;
    }
  }
  return { crit, links };
}
