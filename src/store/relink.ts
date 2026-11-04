import type { State } from '../engine';
import { movedPath, type StoreApp } from './ports';
import type { Patch } from './writer';

/** One link that named `from` when `to` was its note's path. */
export interface LinkFix {
  ref: string;
  key: 'tm-parent' | 'tm-deps' | 'tm-notes';
  from: string;
  to: string;
}

/** Every link to something at or under `from`, as `to` will hold it. Call before the state follows the rename. */
export function staleLinks(st: State, from: string, to: string): LinkFix[] {
  const out: LinkFix[] = [];
  for (const [id, it] of Object.entries(st.items)) {
    const ref = movedPath(id, from, to);
    const links = (key: LinkFix['key'], targets: (string | null | undefined)[]) => {
      for (const t of targets) if (t && movedPath(t, from, to) !== t) out.push({ ref, key, from: t, to: movedPath(t, from, to) });
    };
    links('tm-parent', [it.parent]);
    links('tm-deps', it.deps ?? []);
    links('tm-notes', it.notes ?? []);
  }
  return out;
}

const LINK = /^\[\[([^|#\]]+)([^\]]*)\]\]$/;
const stem = (path: string) => path.replace(/\.md$/, '');

/** A link names a note by its full path or by the tail of it, down to the bare title. */
const namesPath = (linkpath: string, path: string) => {
  const name = stem(linkpath);
  return stem(path) === name || stem(path).endsWith(`/${name}`);
};

/** The link as it should read, or the same value if it already leads to the note or is not this link. */
function fixValue(app: StoreApp, fix: LinkFix, raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const m = LINK.exec(raw.trim());
  if (!m || !namesPath(m[1], fix.from)) return raw;
  if (app.metadataCache.getFirstLinkpathDest(m[1], fix.ref)?.path === fix.to) return raw;
  const file = app.vault.getFileByPath(fix.to);
  return file ? `[[${app.metadataCache.fileToLinktext(file, fix.ref)}${m[2]}]]` : raw;
}

/** Frontmatter patches for the links in `fixes` that still say the old thing. `fmOf` gives a note's frontmatter. */
export function fixLinks(app: StoreApp, fixes: LinkFix[], fmOf: (path: string) => Patch): Map<string, Patch> {
  const out = new Map<string, Patch>();
  for (const fix of fixes) {
    if (!app.vault.getFileByPath(fix.ref)) continue;
    const patch = out.get(fix.ref) ?? {};
    const held = fix.key in patch ? patch[fix.key] : fmOf(fix.ref)[fix.key];
    const next = Array.isArray(held) ? held.map(v => fixValue(app, fix, v)) : fixValue(app, fix, held);
    if (JSON.stringify(next) === JSON.stringify(held)) continue;
    patch[fix.key] = next;
    out.set(fix.ref, patch);
  }
  return out;
}
