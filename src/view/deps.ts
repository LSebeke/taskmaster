import { depBlocker, type KidsMap, type State } from '../engine';

export interface DepGroup {
  path: string;
  items: { id: string; title: string }[];
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** Candidates under their parent path. Paths and items alphabetical. */
function grouped(st: State, skip: (id: string) => boolean): DepGroup[] {
  const groups = new Map<string, DepGroup['items']>();
  for (const [x, cand] of Object.entries(st.items)) {
    if (skip(x)) continue;
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

/** What an item may depend on: cycles left out. */
export function depChoices(st: State, id: string): DepGroup[] {
  const it = st.items[id];
  const blocked = depBlocker(st, id);
  return grouped(st, x => x === id || !!it.deps?.includes(x) || blocked(x));
}

/** What a new item inside `parent` may depend on: it would count among the parent's work. */
export function newDepChoices(st: State, parent: string | null, chosen: string[]): DepGroup[] {
  const blocked = parent ? depBlocker(st, parent) : () => false;
  return grouped(st, x => chosen.includes(x) || blocked(x));
}

/** What an external item can come to block. It has no dependencies, so no loops. */
export function blockChoices(st: State, ext: string): DepGroup[] {
  return grouped(st, x => st.items[x].kind === 'ext' || !!st.items[x].deps?.includes(ext));
}

export interface ParentChoice {
  id: string;
  title: string;
  depth: number;
}

/** The tree, in row order, for choosing a parent. Milestones show only with `all`, as refused places. */
export function parentChoices(st: State, K: KidsMap, all = false): ParentChoice[] {
  const out: ParentChoice[] = [];
  const walk = (ids: string[] | undefined, depth: number) => {
    for (const id of ids ?? []) {
      const { kind, title } = st.items[id];
      if (kind === 'ext' || (kind === 'ms' && !all)) continue;
      out.push({ id, title, depth });
      walk(K[id], depth + 1);
    }
  };
  walk(K[''], 0);
  return out;
}
