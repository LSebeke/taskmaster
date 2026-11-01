import type { CachedMetadata, TFile } from 'obsidian';
import { dayOf, hasCycle, iso, type Day, type Item, type ItemKind, type LogEntry, type Scope, type State } from '../engine';
import type { StoreApp, StoreWarning } from './ports';
import type { Patch } from './writer';

type Warn = (path: string, field: string, msg: string) => void;
type Frontmatter = NonNullable<CachedMetadata['frontmatter']>;

/** Calendar check included: Date.parse rolls 31 Feb over to March. */
export function parseDay(v: unknown): Day | undefined {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = dayOf(v);
  return Number.isNaN(d) || iso(d) !== v ? undefined : d;
}

/** `2026-11-02 3.5`, or undefined. */
export function parseLogEntry(v: unknown): LogEntry | undefined {
  const m = typeof v === 'string' ? /^(\S+)\s+(\d+(?:\.\d+)?)$/.exec(v.trim()) : null;
  const d = m ? parseDay(m[1]) : undefined;
  return d === undefined ? undefined : { d, h: Number(m![2]) };
}

const linkpathOf = (v: unknown) => (typeof v === 'string' ? /^\[\[([^|#\]]+)[^\]]*\]\]$/.exec(v.trim())?.[1] : undefined);

/** Where a `[[link]]` in `source` leads, or null. */
export function linkTarget(app: StoreApp, v: unknown, source: string): string | null {
  const linkpath = linkpathOf(v);
  return linkpath ? (app.metadataCache.getFirstLinkpathDest(linkpath, source)?.path ?? null) : null;
}

/** Reads typed values out of one note's frontmatter. Bad values are skipped and reported. */
class Fields {
  constructor(
    private fm: Frontmatter,
    private warn: (field: string, msg: string) => void,
  ) {}

  /** Empty YAML keys come through as null. */
  private get(field: string): unknown {
    return this.fm[field] ?? undefined;
  }

  num(field: string): number | undefined {
    const v = this.get(field);
    if (v === undefined) return undefined;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    this.warn(field, `Expected hours, got ${JSON.stringify(v)}`);
    return undefined;
  }

  day(field: string): Day | undefined {
    const v = this.get(field);
    if (v === undefined) return undefined;
    const d = parseDay(v);
    if (d === undefined) this.warn(field, `Expected a date, got ${JSON.stringify(v)}`);
    return d;
  }

  scope(): Scope | undefined {
    const v = this.get('tm-scope');
    if (v === undefined) return undefined;
    if (v === 'must' || v === 'should' || v === 'could') return v;
    this.warn('tm-scope', `Expected must, should or could, got ${JSON.stringify(v)}`);
    return undefined;
  }

  /** A lone string in a list field is a likely hand edit, so it counts as a list of one. */
  list(field: string): unknown[] {
    const v = this.get(field);
    if (v === undefined) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return [v];
    this.warn(field, `Expected a list, got ${JSON.stringify(v)}`);
    return [];
  }

  link(field: string, v: unknown, resolve: (linkpath: string) => string | null): string | null {
    const linkpath = linkpathOf(v);
    if (!linkpath) {
      this.warn(field, `Expected a [[link]], got ${JSON.stringify(v)}`);
      return null;
    }
    const to = resolve(linkpath);
    if (!to) this.warn(field, `Nothing found for ${v as string}`);
    return to;
  }

  links(field: string, resolve: (linkpath: string) => string | null): string[] {
    return [...new Set(this.list(field).flatMap(v => this.link(field, v, resolve) ?? []))];
  }

  log(): LogEntry[] {
    const log: LogEntry[] = [];
    for (const e of this.list('tm-log')) {
      const entry = parseLogEntry(e);
      if (entry) log.push(entry);
      else this.warn('tm-log', `Skipped entry ${JSON.stringify(e)}`);
    }
    return log.sort((a, b) => a.d - b.d);
  }
}

const KINDS: Record<string, ItemKind> = { item: 'item', milestone: 'ms', external: 'ext' };

/** Drops undefined values, so optional fields stay absent and projections compare cleanly. */
const compact = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** The cache has no list item text: `t` stays empty until readTodos. */
const todosOf = (cache: CachedMetadata) =>
  (cache.listItems ?? []).filter(l => l.task !== undefined).map(l => ({ t: '', done: l.task !== ' ' }));

function projectNote(app: StoreApp, file: TFile, cache: CachedMetadata, warn: Warn, alias?: ProjectOptions['alias']): Item | null {
  const fm = cache.frontmatter!;
  const f = new Fields(fm, (field, msg) => warn(file.path, field, msg));
  const dest = (linkpath: string) => app.metadataCache.getFirstLinkpathDest(linkpath, file.path)?.path ?? alias?.(linkpath) ?? null;

  const type = fm['tm-type'];
  const kind = typeof type === 'string' ? (KINDS[type] ?? null) : null;
  if (!kind) warn(file.path, 'tm-type', `Expected item, milestone or external, got ${JSON.stringify(type)}`);

  const base = {
    title: file.basename,
    notes: f.links('tm-notes', dest),
    todos: todosOf(cache),
    deadline: f.day('tm-deadline'),
  };

  if (kind === 'ext') {
    if (fm['tm-parent'] != null) warn(file.path, 'tm-parent', 'External items have no parent');
    if (fm['tm-deps'] != null) warn(file.path, 'tm-deps', 'External items have no dependencies');
    const pinS = f.day('tm-pin-start');
    const pinE = f.day('tm-pin-end');
    if (pinS === undefined || pinE === undefined || pinE < pinS) {
      warn(file.path, 'tm-pin-end', 'Left out: external items need a start and an end, in that order');
      return null;
    }
    return compact<Item>({ ...base, kind: 'ext', parent: null, deps: [], pinS, pinE });
  }

  const linked = {
    ...base,
    parent: fm['tm-parent'] == null ? null : f.link('tm-parent', fm['tm-parent'], dest),
    deps: f.links('tm-deps', dest),
    scope: f.scope() ?? ('must' as const),
  };

  if (kind === 'ms') {
    const doneOn = f.day('tm-done');
    return compact<Item>({
      ...linked,
      kind: 'ms',
      pinE: f.day('tm-pin-end') ?? f.day('tm-pin-start'),
      done: doneOn !== undefined ? true : undefined,
      doneOn,
    });
  }

  const log = f.log();
  const est = f.num('tm-estimate');
  const left = f.num('tm-left') ?? 0;
  const spent = log.reduce((a, e) => a + e.h, 0);
  const touched = f.day('tm-left-updated');
  const finished = left === 0 && (spent > 0 || (est ?? 0) > 0);
  return compact<Item>({
    ...linked,
    kind: 'item',
    est,
    left,
    spent,
    budget: f.num('tm-budget'),
    touched,
    log,
    actualStart: f.day('tm-started'),
    pinS: f.day('tm-pin-start'),
    pinE: f.day('tm-pin-end'),
    doneOn: finished ? (touched ?? log.at(-1)?.d) : undefined,
  });
}

/** A loop would hang the engine's tree walks. The earliest path in a loop gives up its parent. */
function breakParentCycles(items: Record<string, Item>, warn: Warn) {
  for (const id in items) {
    const seen = new Set<string>();
    let p = items[id].parent;
    while (p && p !== id && !seen.has(p)) {
      seen.add(p);
      p = items[p].parent;
    }
    if (p === id) {
      items[id].parent = null;
      warn(id, 'tm-parent', 'Ignored: parents form a loop');
    }
  }
}

/** Re-adds links in path order and refuses each one that closes a loop. Only runs when there is one. */
function breakDepCycles(items: Record<string, Item>, warn: Warn) {
  const graph = { items } as State; // hasCycle reads only items.
  if (!hasCycle(graph)) return;
  const wanted = Object.entries(items).map(([id, it]) => [id, it.deps ?? []] as const);
  for (const [id] of wanted) items[id].deps = [];
  for (const [id, deps] of wanted)
    for (const d of deps) {
      items[id].deps!.push(d);
      if (!hasCycle(graph)) continue;
      items[id].deps!.pop();
      warn(id, 'tm-deps', `Ignored ${items[d].title}: dependencies form a loop`);
    }
}

/** Rules that span notes. Runs once every note is known, so links to left-out notes fall away too. */
function settle(items: Record<string, Item>, warn: Warn) {
  for (const [id, it] of Object.entries(items)) {
    if (it.parent) {
      const p = items[it.parent];
      if (p?.kind !== 'item') {
        warn(id, 'tm-parent', p ? `Ignored: ${p.title} cannot have children` : `Ignored: ${it.parent} is not an item`);
        it.parent = null;
      }
    }
    if (it.kind === 'ms' && !it.parent) warn(id, 'tm-parent', 'A milestone needs a parent');
    it.deps = it.deps?.filter(d => {
      if (!items[d]) warn(id, 'tm-deps', `Ignored: ${d} is not an item`);
      return d in items;
    });
  }
  breakParentCycles(items, warn);
  breakDepCycles(items, warn);
}

export interface Projection {
  items: Record<string, Item>;
  warnings: StoreWarning[];
  /** A note in the folder the cache has not reached: the picture may be incomplete. */
  pending: boolean;
}

/** A cache entry with the store's unconfirmed writes laid over it. */
function withOverlay(cache: CachedMetadata, over: Patch | undefined): CachedMetadata {
  if (!over) return cache;
  const frontmatter = { ...cache.frontmatter, ...over };
  for (const k in over) if (over[k] === undefined) delete frontmatter[k];
  return { ...cache, frontmatter: frontmatter as Frontmatter };
}

export interface ProjectOptions {
  /** Where a link leads that the cache no longer resolves, because the note was just renamed. */
  alias?: (linkpath: string) => string | null;
}

/** Hand-set sibling order. Items not listed follow in path order. */
export function inOrder(items: Record<string, Item>, order: string[] | undefined): Record<string, Item> {
  if (!order?.length) return items;
  const rank = new Map(order.map((id, i) => [id, i]));
  const at = (id: string) => rank.get(id) ?? order.length;
  return Object.fromEntries(Object.entries(items).sort(([a], [b]) => at(a) - at(b)));
}

/**
 * Notes under `folder` with a `tm-type` become items, keyed by path. Cache only: no file reads.
 * `overlay` supplies values written but not yet back from the cache, so a local edit and its later
 * echo project to the same thing.
 */
export function projectNotes(app: StoreApp, folder: string, overlay: (path: string) => Patch | undefined = () => undefined, opts: ProjectOptions = {}): Projection {
  const warnings: StoreWarning[] = [];
  const warn: Warn = (path, field, msg) => warnings.push({ path, field, msg });
  let pending = false;
  const notes: { file: TFile; cache: CachedMetadata }[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(folder)) continue;
    const raw = app.metadataCache.getFileCache(file);
    const over = overlay(file.path);
    // A note the store just wrote is known before the cache has it.
    if (!raw && !over?.['tm-type']) {
      pending = true;
      continue;
    }
    const cache = withOverlay(raw ?? {}, over);
    if (cache.frontmatter && 'tm-type' in cache.frontmatter) notes.push({ file, cache });
  }
  // Key order decides who joins a level first, so it must not depend on vault order.
  notes.sort((a, b) => (a.file.path < b.file.path ? -1 : 1));

  const items: Record<string, Item> = {};
  for (const { file, cache } of notes) {
    const it = projectNote(app, file, cache, warn, opts.alias);
    if (it) items[file.path] = it;
  }
  settle(items, warn);
  return { items, warnings, pending };
}
