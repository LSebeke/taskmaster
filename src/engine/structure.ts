import { hasCycle, kids } from './graph';
import type { Day, Item, ItemKind, Scope, State } from './types';

export interface NewItem {
  kind: ItemKind;
  title: string;
  parent?: string | null;
  hours?: number;
  deps?: string[];
  deadline?: Day;
  scope?: Scope;
  pinS?: Day;
  pinE?: Day;
  /** Priority level. Default: the old parent's, else the last. */
  tier?: number;
  /** Note path, when the caller has one. Default: generated. */
  id?: string;
}

/** Field-level checks. `newItemError` adds what needs the state. */
export function validateNew(n: NewItem): string | null {
  if (!n.title?.trim()) return 'Give it a name.';
  if (n.kind === 'ext') {
    if (n.pinS == null || n.pinE == null) return 'External items need a start and an end date.';
    if (n.pinE < n.pinS) return 'End is before start.';
    return null;
  }
  if (n.hours != null && n.hours < 0) return 'Hours cannot be negative.';
  if (n.kind === 'ms' && !n.parent) return 'A milestone needs a parent.';
  if (n.pinS != null && n.pinE != null && n.pinE < n.pinS) return 'End pin is before the start pin.';
  return null;
}

/** Why this item cannot be added, or null. */
export function newItemError(st: State, n: NewItem): string | null {
  const field = validateNew(n);
  if (field || n.kind === 'ext') return field;
  const P = n.parent ? st.items[n.parent] : null;
  if (n.parent && !P) return 'That parent is gone.';
  if (P?.kind === 'ms') return 'Milestones cannot have children.';
  if (P?.kind === 'ext') return 'External items cannot have children.';
  const trial = structuredClone(st);
  addItem(trial, n);
  return hasCycle(trial) ? 'That would create a dependency loop.' : null;
}

/** First child: the item's hours become its budget. Logged hours stay counted. Returns its old priority level. */
function adopt(st: State, p: string | null | undefined): number {
  if (!p || kids(st)[p]) return -1;
  const P = st.items[p];
  const total = (P.spent ?? 0) + (P.left ?? 0);
  const level = st.tiers.findIndex(t => t.includes(p));
  if (total > 0 && P.budget == null) P.budget = total;
  P.left = 0;
  P.doneOn = null;
  delete P.pinS;
  delete P.pinE;
  return level;
}

/** Last child gone: the budget becomes hours again. */
function release(st: State, p: string | null | undefined): void {
  if (!p || !st.items[p] || kids(st)[p]) return;
  const P = st.items[p];
  if (P.budget != null) {
    P.left = Math.max(0, P.budget - (P.spent ?? 0));
    delete P.budget;
  }
  if (!(P.left! > 0) && P.spent! > 0) P.doneOn = st.today;
}

/** New items have no plan until Update plan. */
export function addItem(st: State, n: NewItem): string {
  st.seq = (st.seq ?? 0) + 1;
  let id = n.id ?? `n${st.seq}`;
  while (!n.id && st.items[id]) id = `n${++st.seq}`;

  if (n.kind === 'ext') {
    st.items[id] = { title: n.title.trim(), parent: null, kind: 'ext', pinS: n.pinS, pinE: n.pinE, deps: [], todos: [], notes: [] };
    return id;
  }
  const ms = n.kind === 'ms';
  const h = n.hours ?? 0;
  const it: Item = {
    title: n.title.trim(),
    parent: n.parent || null,
    kind: ms ? 'ms' : 'item',
    scope: n.scope ?? 'must',
    deps: [...(n.deps ?? [])],
    todos: [],
    notes: [],
  };
  if (n.deadline != null) it.deadline = n.deadline;
  if (!ms) {
    it.est = h;
    it.spent = 0;
    it.left = h;
    if (n.pinS != null) it.pinS = n.pinS;
  }
  if (n.pinE != null) it.pinE = n.pinE;
  const from = adopt(st, n.parent);
  st.items[id] = it;
  if (!ms && h > 0) {
    if (!st.tiers.length) st.tiers.push([]);
    st.tiers[Math.min(n.tier ?? (from >= 0 ? from : st.tiers.length - 1), st.tiers.length - 1)].push(id);
  }
  return id;
}

/** Why id cannot move under parent (null: top level), or null if it can. */
export function moveError(st: State, id: string, parent: string | null): string | null {
  const it = st.items[id];
  const P = parent ? st.items[parent] : null;
  if (it.kind === 'ext') return 'External items stay in their own section.';
  if (it.kind === 'ms' && !parent) return 'A milestone needs a parent.';
  if (P?.kind === 'ms') return 'Milestones cannot have children.';
  if (P?.kind === 'ext') return 'External items cannot have children.';
  for (let i = parent; i; i = st.items[i].parent) if (i === id) return 'An item cannot move inside itself.';
  if ((parent ?? null) === (it.parent ?? null)) return null;
  const moved: State = { ...st, items: { ...st.items, [id]: { ...it, parent: parent || null } } };
  return hasCycle(moved) ? 'That would create a dependency loop.' : null;
}

/** Sibling order is item order: beforeId places it, null puts it last. */
export function moveItem(st: State, id: string, parent: string | null, beforeId: string | null = null): void {
  const from = st.items[id].parent ?? null;
  const to = parent || null;
  if (to !== from) adopt(st, to);
  st.items[id].parent = to;
  const entries = Object.entries(st.items).filter(([k]) => k !== id);
  const at = beforeId ? entries.findIndex(([k]) => k === beforeId) : -1;
  entries.splice(at < 0 ? entries.length : at, 0, [id, st.items[id]]);
  st.items = Object.fromEntries(entries);
  if (to !== from) release(st, from);
}

/** Removes the subtree, its plan and priority entries and dependencies on it. Returns the item count. */
export function removeItem(st: State, id: string): number {
  const K = kids(st);
  const gone = new Set<string>();
  const walk = (i: string) => {
    gone.add(i);
    (K[i] ?? []).forEach(walk);
  };
  const from = st.items[id].parent;
  walk(id);
  for (const i of gone) {
    delete st.items[i];
    delete st.plan[i];
  }
  st.tiers = st.tiers.map(t => t.filter(x => !gone.has(x)));
  for (const i in st.items) {
    const it = st.items[i];
    if (it.deps) it.deps = it.deps.filter(d => !gone.has(d));
  }
  release(st, from);
  return gone.size;
}
