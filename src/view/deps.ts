import { depBlocker, type State } from '../engine';

export interface DepGroup {
  path: string;
  items: { id: string; title: string }[];
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** Add-dependency candidates under their parent path. Paths and items alphabetical, cycles left out. */
export function depChoices(st: State, id: string): DepGroup[] {
  const it = st.items[id];
  const blocked = depBlocker(st, id);
  const groups = new Map<string, DepGroup['items']>();
  for (const [x, cand] of Object.entries(st.items)) {
    if (x === id || it.deps?.includes(x) || blocked(x)) continue;
    const path: string[] = [];
    for (let p = cand.parent; p; p = st.items[p].parent) path.unshift(st.items[p].title);
    const key = path.join(' › ') || (cand.kind === 'ext' ? 'External' : 'Projects');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ id: x, title: cand.title });
  }
  return [...groups]
    .sort(([a], [b]) => byName(a, b))
    .map(([path, items]) => ({ path, items: items.sort((a, b) => byName(a.title, b.title)) }));
}
