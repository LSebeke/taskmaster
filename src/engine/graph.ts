import type { KidsMap, State } from './types';

export const kids = (st: State): KidsMap => {
  const k: KidsMap = {};
  for (const id in st.items) (k[st.items[id].parent ?? ''] ||= []).push(id);
  return k;
};

/** One kind of item. Having children decides everything: parents roll up, childless items carry hours. */
export function leavesOf(st: State, id: string, K: KidsMap = kids(st)): string[] {
  const out: string[] = [];
  const walk = (i: string) => {
    const c = K[i];
    if (c) c.forEach(walk);
    else out.push(i);
  };
  walk(id);
  return out;
}

export const isDraft = (st: State, id: string, K: KidsMap): boolean => {
  const it = st.items[id];
  return it.kind === 'item' && !K[id] && !(it.left! > 0) && !(it.spent! > 0) && it.doneOn == null;
};

/** An item waits for its own dependencies and those of every ancestor. */
export function effDeps(st: State, id: string, K: KidsMap): string[] {
  const out = new Set<string>();
  for (let i: string | null = id; i; i = st.items[i].parent)
    for (const d of st.items[i].deps ?? []) for (const l of leavesOf(st, d, K)) out.add(l);
  return [...out];
}

export function rootOf(st: State, id: string): string {
  let i = id;
  while (st.items[i].parent) i = st.items[i].parent!;
  return i;
}

export function hasCycle(st: State): boolean {
  const K = kids(st);
  const state: Record<string, 1 | 2> = {};
  const visit = (id: string): boolean => {
    if (state[id] === 1) return true;
    if (state[id] === 2) return false;
    state[id] = 1;
    for (const d of effDeps(st, id, K)) if (visit(d)) return true;
    state[id] = 2;
    return false;
  };
  return Object.keys(st.items).some(id => !K[id] && visit(id));
}

/** Why id cannot depend on dep, or null if it can. */
export function depError(st: State, id: string, dep: string): string | null {
  const it = st.items[id];
  const to = st.items[dep];
  if (!it || !to) return 'That item is gone.';
  if (id === dep) return 'An item cannot depend on itself.';
  if (it.kind === 'ext') return 'External items have no dependencies of their own.';
  if (it.deps?.includes(dep)) return `${it.title} already depends on ${to.title}.`;
  return depBlocker(st, id)(dep) ? 'That would create a dependency loop.' : null;
}

/** Everything that may not become a predecessor of id. */
export function depBlocker(st: State, id: string): (candidate: string) => boolean {
  const K = kids(st);
  const expand = (i: string) => leavesOf(st, i, K);
  const reverse: Record<string, string[]> = {};
  for (const x in st.items)
    for (const d of st.items[x].deps ?? [])
      for (const l of expand(d)) (reverse[l] ||= []).push(...expand(x));
  const seen = new Set<string>();
  const stack = expand(id);
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c)) continue;
    seen.add(c);
    stack.push(...(reverse[c] ?? []));
  }
  return x => expand(x).some(l => seen.has(l));
}
