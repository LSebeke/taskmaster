import { kids } from './graph';
import type { State } from './types';

/** Priority levels are created and removed deliberately. Order inside a level is display only. */
export function moveToTier(tiers: string[][], id: string, ti: number, beforeId?: string | null): string[][] {
  const t = tiers.map(x => x.filter(y => y !== id));
  const at = beforeId ? t[ti].indexOf(beforeId) : -1;
  if (at < 0) t[ti].push(id);
  else t[ti].splice(at, 0, id);
  return t;
}

export const addTier = (tiers: string[][], at: number): string[][] => {
  const t = tiers.map(x => [...x]);
  t.splice(at, 0, []);
  return t;
};

/** Only an empty level can go. */
export const removeTier = (tiers: string[][], at: number): string[][] =>
  tiers[at].length ? tiers : tiers.filter((_, i) => i !== at);

/** Keeps levels holding exactly the open tasks. Not part of analyze: call it after structural or hour changes.
 *  Spec: finished tasks leave their level, so a reopened task lands in the last one. */
export function ensureTiers(st: State): void {
  const K = kids(st);
  st.tiers = st.tiers.map(t => t.filter(id => st.items[id] && !K[id] && st.items[id].left! > 0));
  const seen = new Set(st.tiers.flat());
  for (const id in st.items) {
    const it = st.items[id];
    if (it.kind === 'ms' || K[id] || !(it.left! > 0) || seen.has(id)) continue;
    if (!st.tiers.length) st.tiers.push([]);
    st.tiers[st.tiers.length - 1].push(id);
  }
}
