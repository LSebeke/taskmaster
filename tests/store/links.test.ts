import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayOf as D } from '../../src/engine';
import { TaskmasterStore } from '../../src/store';
import { FakeObsidian } from './fake-obsidian';

const p = (name: string) => `Projects/${name}.md`;
const task = (left = 12, extra = {}) => ({ 'tm-type': 'item', 'tm-estimate': left, 'tm-left': left, ...extra });

let o: FakeObsidian;
let store: TaskmasterStore;

const boot = async () => {
  store = new TaskmasterStore(o.app, { today: () => D('2026-11-02'), debounceMs: 100, writeMs: 300 });
  await store.load();
  await vi.advanceTimersByTimeAsync(0);
};
/** The repair's window, then its write, then the cache. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(300);
  await vi.advanceTimersByTimeAsync(300);
  o.deliver();
  await vi.advanceTimersByTimeAsync(100);
};
const reload = async () => {
  store.dispose();
  await store.flush();
  o.deliver();
  await boot();
};

beforeEach(() => {
  vi.useFakeTimers();
  o = new FakeObsidian();
  o.folders.add('Projects');
  o.linkUpdates = false;
});

afterEach(() => {
  store.dispose();
  vi.useRealTimers();
});

describe('links after a rename, with Obsidian not updating links', () => {
  it('tm-deps, tm-parent and tm-notes follow a rename, on disk, through a reload', async () => {
    o.add('Projects/P/P.md', task(0, { 'tm-deps': ['[[a]]'] }));
    o.add('Projects/P/c.md', task(6, { 'tm-parent': '[[P]]', 'tm-notes': ['[[a]]'] }));
    o.add(p('a'), task());
    await boot();
    await store.rename(p('a'), 'renamed');
    await store.rename('Projects/P/P.md', 'Q');
    await settle();
    expect(o.frontmatter('Projects/Q/Q.md')['tm-deps']).toEqual(['[[renamed]]']);
    expect(o.frontmatter('Projects/Q/c.md')['tm-notes']).toEqual(['[[renamed]]']);
    expect(o.frontmatter('Projects/Q/c.md')['tm-parent']).toBe('[[Q]]');
    await reload();
    expect(store.state.items['Projects/Q/Q.md'].deps).toEqual([p('renamed')]);
    expect(store.state.items['Projects/Q/c.md'].parent).toBe('Projects/Q/Q.md');
    expect(store.warnings).toEqual([]);
  });

  it('a link holding a full path follows a folder move', async () => {
    o.add('Projects/P/P.md', task(0));
    o.add('Projects/P/c.md', task(6, { 'tm-parent': '[[Projects/P/P]]' }));
    o.add(p('a'), task(6, { 'tm-deps': ['[[Projects/P/c]]'] }));
    await boot();
    await store.rename('Projects/P/P.md', 'Q');
    await settle();
    expect(o.frontmatter(p('a'))['tm-deps']).toEqual(['[[c]]']);
    expect(o.frontmatter('Projects/Q/c.md')['tm-parent']).toBe('[[Q]]');
  });

  it('a rename done outside the plugin is repaired too', async () => {
    o.add(p('a'), task());
    o.add(p('b'), task(6, { 'tm-deps': ['[[a]]'] }));
    await boot();
    await o.app.fileManager.renameFile(o.app.vault.getFileByPath(p('a'))!, p('z'));
    await settle();
    expect(o.frontmatter(p('b'))['tm-deps']).toEqual(['[[z]]']);
  });

  it('a linked note outside the items follows too', async () => {
    o.add('Notes/call.md');
    o.add(p('a'), task(6, { 'tm-notes': ['[[call]]'] }));
    await boot();
    await o.app.fileManager.renameFile(o.app.vault.getFileByPath('Notes/call.md')!, 'Notes/talk.md');
    await settle();
    expect(o.frontmatter(p('a'))['tm-notes']).toEqual(['[[talk]]']);
  });

  it('a link does not jump to another note of the old name', async () => {
    o.add('Elsewhere/a.md');
    o.add(p('a'), task());
    o.add(p('b'), task(6, { 'tm-deps': ['[[Projects/a]]'] }));
    await boot();
    await store.rename(p('a'), 'z');
    await settle();
    expect(o.frontmatter(p('b'))['tm-deps']).toEqual(['[[z]]']);
    expect(store.state.items[p('b')].deps).toEqual([p('z')]);
  });

  it('keeps a display name, unrelated links and entries it cannot read', async () => {
    o.add(p('a'), task());
    o.add(p('k'), task());
    o.add(p('b'), task(6, { 'tm-deps': ['[[a|The A]]', '[[k]]', 'not a link'] }));
    await boot();
    await store.rename(p('a'), 'z');
    await settle();
    expect(o.frontmatter(p('b'))['tm-deps']).toEqual(['[[z|The A]]', '[[k]]', 'not a link']);
  });

  it('keeps a lone string a lone string', async () => {
    o.add(p('a'), task());
    o.add(p('b'), task(6, { 'tm-deps': '[[a]]' }));
    await boot();
    await store.rename(p('a'), 'z');
    await settle();
    expect(o.frontmatter(p('b'))['tm-deps']).toBe('[[z]]');
  });

  it('a chain of renames inside one window lands on the last name', async () => {
    o.add(p('a'), task());
    o.add(p('b'), task(6, { 'tm-deps': ['[[a]]'] }));
    await boot();
    await store.rename(p('a'), 'y');
    await store.rename(p('y'), 'z');
    await settle();
    expect(o.frontmatter(p('b'))['tm-deps']).toEqual(['[[z]]']);
  });

  it('undoing the rename repairs back', async () => {
    o.add(p('a'), task());
    o.add(p('b'), task(6, { 'tm-deps': ['[[a]]'] }));
    await boot();
    await store.rename(p('a'), 'z');
    await settle();
    await store.undo();
    await settle();
    expect(o.frontmatter(p('b'))['tm-deps']).toEqual(['[[a]]']);
  });

  it('a reload right after a rename loses nothing: dispose writes the repair', async () => {
    o.add(p('a'), task());
    o.add(p('b'), task(6, { 'tm-deps': ['[[a]]'] }));
    await boot();
    await store.rename(p('a'), 'z');
    await reload();
    expect(store.state.items[p('b')].deps).toEqual([p('z')]);
  });

  it('is not an edit: nothing on the undo stack but the rename', async () => {
    o.add(p('a'), task());
    o.add(p('b'), task(6, { 'tm-deps': ['[[a]]'] }));
    await boot();
    await store.rename(p('a'), 'z');
    await settle();
    expect(store.undoLabel).toBe('Renamed a to z');
  });
});

describe('links after a rename, with Obsidian updating links', () => {
  beforeEach(() => {
    o.linkUpdates = true;
  });

  it('nothing is left to fix once the cache has caught up', async () => {
    o.add(p('a'), task());
    o.add(p('b'), task(6, { 'tm-deps': ['[[a]]'] }));
    await boot();
    await store.rename(p('a'), 'z');
    o.deliver();
    await vi.advanceTimersByTimeAsync(100);
    o.writes.length = 0;
    await settle();
    expect(o.writes).toEqual([]);
    expect(o.frontmatter(p('b'))['tm-deps']).toEqual(['[[z]]']);
  });

  it('a cache still behind costs no change on disk', async () => {
    o.add(p('a'), task());
    o.add(p('b'), task(6, { 'tm-deps': ['[[a]]'] }));
    await boot();
    await store.rename(p('a'), 'z');
    await settle();
    expect(o.frontmatter(p('b'))['tm-deps']).toEqual(['[[z]]']);
    expect(store.state.items[p('b')].deps).toEqual([p('z')]);
  });
});

describe('backlinks', () => {
  it('notes that link to an item, in path order', async () => {
    o.add(p('a'), task());
    o.add('Notes/z.md', undefined, undefined, 'See [[a]]');
    o.add('Notes/b.md', undefined, undefined, 'See [[a]] and [[a]]');
    await boot();
    expect(store.backlinks(p('a'))).toEqual(['Notes/b.md', 'Notes/z.md']);
  });

  it('leaves out structure: children and dependents link through tm-parent and tm-deps', async () => {
    o.add('Projects/P/P.md', task(0));
    o.add('Projects/P/c.md', task(6, { 'tm-parent': '[[P]]' }));
    o.add(p('d'), task(6, { 'tm-deps': ['[[P]]'] }));
    await boot();
    expect(store.backlinks('Projects/P/P.md')).toEqual([]);
  });

  it("leaves out notes already in the item's tm-notes, and the note itself", async () => {
    o.add(p('a'), task(6, { 'tm-notes': ['[[call]]'] }), undefined, 'Self: [[a]]');
    o.add('Notes/call.md', undefined, undefined, '[[a]]');
    await boot();
    expect(store.backlinks(p('a'))).toEqual([]);
  });

  it('an item may be a plain referrer: tm-notes on another item counts', async () => {
    o.add(p('a'), task());
    o.add(p('b'), task(6, { 'tm-notes': ['[[a]]'] }));
    await boot();
    expect(store.backlinks(p('a'))).toEqual([p('b')]);
  });

  it('nothing for an unknown item', async () => {
    await boot();
    expect(store.backlinks(p('gone'))).toEqual([]);
  });
});
