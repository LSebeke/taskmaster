import { iso, type Day, type Item, type LogEntry, type State } from '../engine';
import type { StoreApp } from './ports';
import { linkTarget, parseLogEntry } from './project';
import type { Patch } from './writer';

/** Hours keep three decimals, so 0.1 + 0.2 does not reach the note. */
const hours = (n: number | undefined) => (n == null ? undefined : Math.round(n * 1000) / 1000);
const date = (d: Day | null | undefined) => (d == null ? undefined : iso(d));

const logEntry = (e: LogEntry) => `${iso(e.d)} ${hours(e.h)}`;

/** One field per key. `spent` and a task's `doneOn` derive from these, so neither is here. */
function plainFields(it: Item): Patch {
  return {
    'tm-left': it.kind === 'item' ? hours(it.left) : undefined,
    'tm-left-updated': date(it.touched),
    'tm-estimate': hours(it.est),
    'tm-budget': hours(it.budget),
    'tm-deadline': date(it.deadline),
    'tm-pin-start': date(it.pinS),
    'tm-pin-end': date(it.pinE),
    'tm-scope': it.scope,
    'tm-started': date(it.actualStart),
    'tm-done': it.kind === 'ms' ? date(it.doneOn) : undefined,
  };
}

/** Edits a link list in place: entries it does not understand stay. */
function patchLinks(app: StoreApp, id: string, raw: unknown, before: string[], after: string[]): unknown[] {
  const list: unknown[] = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const gone = before.filter(x => !after.includes(x));
  const kept = list.filter(v => {
    const to = linkTarget(app, v, id);
    return to == null || !gone.includes(to);
  });
  const added = after
    .filter(x => !before.includes(x))
    .map(x => {
      const file = app.vault.getFileByPath(x);
      return `[[${file ? app.metadataCache.fileToLinktext(file, id) : x.replace(/\.md$/, '')}]]`;
    });
  return [...kept, ...added];
}

const TYPES = { item: 'item', ms: 'milestone', ext: 'external' };

/** Frontmatter of a note that does not exist yet. */
export function noteFields(app: StoreApp, id: string, it: Item): Patch {
  const links = (to: string[] | undefined) => (to?.length ? patchLinks(app, id, null, [], to) : undefined);
  const est = it.est ? hours(it.est) : undefined;
  const fm: Patch = {
    'tm-type': TYPES[it.kind],
    'tm-parent': links(it.parent ? [it.parent] : [])?.[0],
    'tm-deps': links(it.deps),
    ...plainFields(it),
    'tm-estimate': est,
  };
  return Object.fromEntries(Object.entries(fm).filter(([, v]) => v !== undefined));
}

const list = (x: unknown[] | undefined) => JSON.stringify(x ?? []);

/** Keys that differ between two versions of an item. `fm` is what the note holds now. */
function itemPatch(app: StoreApp, id: string, was: Item, now: Item, fm: Patch): Patch {
  const patch: Patch = {};
  const a = plainFields(was);
  const b = plainFields(now);
  for (const k in b) if (a[k] !== b[k]) patch[k] = b[k];

  if (list(was.deps) !== list(now.deps)) patch['tm-deps'] = patchLinks(app, id, fm['tm-deps'], was.deps ?? [], now.deps ?? []);
  if (list(was.notes) !== list(now.notes)) patch['tm-notes'] = patchLinks(app, id, fm['tm-notes'], was.notes ?? [], now.notes ?? []);
  if ((was.parent ?? null) !== (now.parent ?? null)) patch['tm-parent'] = now.parent ? patchLinks(app, id, null, [], [now.parent])[0] : undefined;
  if (list(was.log) !== list(now.log)) {
    const raw: unknown[] = Array.isArray(fm['tm-log']) ? fm['tm-log'] : [];
    patch['tm-log'] = [...raw.filter(e => !parseLogEntry(e)), ...(now.log ?? []).map(logEntry)];
  }
  // A milestone's date may sit in either pin key: end, else start.
  if (now.kind === 'ms' && was.pinE !== now.pinE) patch['tm-pin-start'] = undefined;

  for (const k in patch) if (patch[k] === undefined && fm[k] === undefined) delete patch[k];
  return patch;
}

/** Note patches between two states. An item only one side has is file work, and its caller's. */
export function notePatches(app: StoreApp, before: State, after: State, fmOf: (id: string) => Patch): Map<string, Patch> {
  const out = new Map<string, Patch>();
  for (const id in after.items) {
    const was = before.items[id];
    if (!was) continue;
    const patch = itemPatch(app, id, was, after.items[id], fmOf(id));
    if (Object.keys(patch).length) out.set(id, patch);
  }
  return out;
}
