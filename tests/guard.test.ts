/**
 * The plugin runs with the user's full rights. These are the ways code reaches the network, runs strings,
 * or turns note text into markup. Each use is listed with its count, so a new one fails here until
 * someone reads it and adds it on purpose.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

const RISKY: Record<string, RegExp> = {
  'raw HTML': /\b(innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|createContextualFragment)\b|document\.write\b/g,
  'string as code': /\beval\s*\(|\bnew\s+Function\b|\bset(Timeout|Interval)\s*\(\s*['"`]/g,
  network: /\b(fetch|requestUrl|request|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(|\bnew\s+(XMLHttpRequest|WebSocket|EventSource)\b/g,
  'Node and Electron': /\brequire\s*\(|\bimport\s*\(|['"](node:)?(fs|child_process|net|http|https|os|electron)['"]/g,
  'outside links': /\bwindow\.open\b|\bopenExternal\b|\blocation\.(href|assign|replace)\b/g,
  'raw file access': /\.adapter\./g,
};

/** Reviewed uses: what, where, how many. Raw HTML only ever takes the fixed eye icons in hierarchy.ts. */
const ALLOWED: Record<string, Record<string, number>> = {
  'raw HTML': { 'view/hierarchy.ts': 1, 'view/chrome.tsx': 1 },
  // Keeps an unreadable state.json aside inside the vault's own folder.
  'raw file access': { 'store/store.ts': 1 },
};

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));

const found = (re: RegExp) => {
  const out: Record<string, number> = {};
  for (const f of files(SRC)) {
    const n = readFileSync(f, 'utf8').match(re)?.length ?? 0;
    if (n) out[relative(SRC, f).split('\\').join('/')] = n;
  }
  return out;
};

describe('guard: risky code only where reviewed', () => {
  for (const [kind, re] of Object.entries(RISKY)) {
    it(kind, () => expect(found(re)).toEqual(ALLOWED[kind] ?? {}));
  }

  it('raw HTML takes only the fixed icons', () => {
    const html = new RegExp(RISKY['raw HTML'].source);
    const uses = files(SRC).flatMap(f => readFileSync(f, 'utf8').split('\n').filter(l => html.test(l)));
    expect(uses).toHaveLength(2);
    for (const l of uses) expect(l).toMatch(/innerHTML = EYE;|__html: hidden\.length \? EYE_OFF : EYE/);
  });
});
