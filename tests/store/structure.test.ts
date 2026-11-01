import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyze, dayOf as D, type NewItem } from '../../src/engine';
import { addDep, linkNote, removeDep, setPin, setTotal, TaskmasterStore, unlinkNote } from '../../src/store';
import { FakeObsidian } from './fake-obsidian';

const p = (name: string) => `Projects/${name}.md`;
const task = (left = 12, extra = {}) => ({ 'tm-type': 'item', 'tm-estimate': left, 'tm-left': left, ...extra });
const NEW = { kind: 'item' } as const;

let o: FakeObsidian;
let store: TaskmasterStore;
let labels: (string | undefined)[];

const boot = async () => {
  store = new TaskmasterStore(o.app, { today: () => D('2026-11-02'), debounceMs: 100, writeMs: 300 });
  await store.load();
  await vi.advanceTimersByTimeAsync(0);
  labels = [];
  store.subscribe((_, label) => labels.push(label));
};
/** Writes land, the cache catches up, the recompute window passes. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(300);
  o.deliver();
  await vi.advanceTimersByTimeAsync(100);
  o.deliver();
  await vi.advanceTimersByTimeAsync(100);
};
const add = (n: Partial<NewItem>) => store.create({ ...NEW, title: 'New', ...n } as NewItem);
const items = () => store.state.items;
const paths = () => [...o.notes.keys()].sort();
const stateFile = () => JSON.parse(o.stateJson!);

beforeEach(() => {
  vi.useFakeTimers();
  o = new FakeObsidian();
  o.folders.add('Projects');
});

afterEach(() => {
  store.dispose();
  vi.useRealTimers();
});

describe('creating', () => {
  it('a project: a note at the top of the folder, in the forecast at once, out of the plan', async () => {
    await boot();
    const { id, error } = await add({ title: 'Alpha', hours: 12, deadline: D('2026-12-01'), scope: 'could' });
    expect(error).toBeUndefined();
    expect(id).toBe(p('Alpha'));
    expect(items()[id!]).toMatchObject({ title: 'Alpha', left: 12, est: 12, scope: 'could', deadline: D('2026-12-01'), parent: null });
    expect(store.state.tiers.flat()).toContain(id);
    expect(store.state.plan[id!]).toBeUndefined();
    expect(analyze(store.state).by[id!].end).not.toBeNull();
    expect(labels).toEqual(['Added Alpha']);
    await settle();
    expect(o.frontmatter(id!)).toMatchObject({ 'tm-type': 'item', 'tm-left': 12, 'tm-estimate': 12, 'tm-scope': 'could', 'tm-deadline': '2026-12-01' });
    expect(items()[id!]).toMatchObject({ left: 12 });
    expect(labels).toEqual(['Added Alpha']);
  });

  it('a draft: no hours, no level', async () => {
    await boot();
    const { id } = await add({ title: 'Draft' });
    expect(analyze(store.state).by[id!]).toMatchObject({ draft: true, end: null });
    expect(store.state.tiers.flat()).not.toContain(id);
  });

  it('an item in a folder parent: <parent folder>/<title>.md, with a link to the parent', async () => {
    o.add('Projects/P/P.md', task(0));
    o.add('Projects/P/a.md', task(6, { 'tm-parent': '[[P]]' }));
    await boot();
    const { id } = await add({ title: 'b', parent: 'Projects/P/P.md', hours: 3, deps: ['Projects/P/a.md'] });
    expect(id).toBe('Projects/P/b.md');
    expect(items()[id!]).toMatchObject({ parent: 'Projects/P/P.md', deps: ['Projects/P/a.md'] });
    await settle();
    expect(o.frontmatter(id!)).toMatchObject({ 'tm-parent': '[[P]]', 'tm-deps': ['[[a]]'] });
  });

  it('a milestone: its date in tm-pin-end, no hours, no level', async () => {
    o.add('Projects/P/P.md', task(0));
    o.add('Projects/P/a.md', task(6, { 'tm-parent': '[[P]]' }));
    await boot();
    const { id } = await add({ kind: 'ms', title: 'Ship', parent: 'Projects/P/P.md', pinE: D('2026-12-01') });
    await settle();
    expect(o.frontmatter(id!)).toMatchObject({ 'tm-type': 'milestone', 'tm-pin-end': '2026-12-01' });
    expect(o.frontmatter(id!)['tm-left']).toBeUndefined();
    expect(items()[id!]).toMatchObject({ kind: 'ms', pinE: D('2026-12-01') });
    expect(store.state.tiers.flat()).not.toContain(id);
  });

  it('an external item lives in _external, with both dates', async () => {
    await boot();
    const { id } = await add({ kind: 'ext', title: 'Outage', pinS: D('2026-11-02'), pinE: D('2026-11-04') });
    expect(id).toBe('Projects/_external/Outage.md');
    await settle();
    expect(o.frontmatter(id!)).toEqual({ 'tm-type': 'external', 'tm-pin-start': '2026-11-02', 'tm-pin-end': '2026-11-04' });
    expect(items()[id!]).toMatchObject({ kind: 'ext', parent: null });
  });

  it('title clashes get a suffix, also against a folder', async () => {
    o.add(p('Alpha'), task());
    o.folders.add('Projects/Beta');
    await boot();
    expect((await add({ title: 'Alpha' })).id).toBe(p('Alpha 2'));
    expect((await add({ title: 'Alpha' })).id).toBe(p('Alpha 3'));
    expect((await add({ title: 'Beta' })).id).toBe(p('Beta 2'));
    expect(items()[p('Alpha 2')].title).toBe('Alpha 2');
  });

  it('characters a file name cannot hold become dashes', async () => {
    await boot();
    expect((await add({ title: 'a/b: c#d' })).id).toBe(p('a-b- c-d'));
  });

  it('refuses what the engine refuses, and touches nothing', async () => {
    o.add('Projects/P/P.md', task(0));
    o.add('Projects/P/m.md', { 'tm-type': 'milestone', 'tm-parent': '[[P]]' });
    await boot();
    const was = paths();
    expect((await add({ title: '' })).error).toMatch(/name/i);
    expect((await add({ kind: 'ms', title: 'x' })).error).toMatch(/parent/);
    expect((await add({ title: 'x', parent: 'Projects/P/m.md' })).error).toMatch(/Milestones cannot/);
    expect(paths()).toEqual(was);
    expect(store.undoLabel).toBeNull();
  });

  it('undo takes the note away again', async () => {
    await boot();
    const { id } = await add({ title: 'Alpha', hours: 6 });
    await settle();
    await store.undo();
    expect(items()[id!]).toBeUndefined();
    expect(store.state.tiers.flat()).not.toContain(id);
    expect(o.notes.has(id!)).toBe(false);
    expect(o.trashed).toEqual([id]);
    await settle();
    expect(stateFile().tiers.flat()).not.toContain(id);
    expect(labels.at(-1)).toBe('Undid: Added Alpha');
  });
});

describe('the first child', () => {
  const bootParent = async () => {
    o.add(p('T'), task(16, { 'tm-log': ['2026-10-30 2'], 'tm-left': 14, 'tm-pin-start': '2026-11-20', 'tm-deps': ['[[x]]'], 'tm-deadline': '2027-01-01' }));
    o.add(p('x'), task(6));
    o.add(p('y'), task(6));
    o.stateJson = JSON.stringify({ tiers: [[p('y')], [p('T'), p('x')], []] });
    await boot();
  };

  it('moves the parent note to <title>/<title>.md, makes its hours a budget and gives the child its level', async () => {
    await bootParent();
    const { id } = await add({ title: 'Child', parent: p('T'), hours: 4 });
    const P = 'Projects/T/T.md';
    expect(id).toBe('Projects/T/Child.md');
    expect(o.notes.has(p('T'))).toBe(false);
    expect(o.notes.has(P)).toBe(true);
    expect(items()[P]).toMatchObject({ budget: 16, left: 0, spent: 2, deps: [p('x')], deadline: D('2027-01-01') });
    expect(items()[P].pinS).toBeUndefined();
    expect(items()[id!].parent).toBe(P);
    expect(store.state.tiers).toEqual([[p('y')], [p('x'), id], []]);
    expect(analyze(store.state).by[P].spent).toBe(2);
    expect(store.undoLabel).toBe('Added Child');
    expect(labels).toEqual(['Added Child']);
    await settle();
    expect(o.frontmatter(P)).toMatchObject({ 'tm-budget': 16, 'tm-left': 0, 'tm-log': ['2026-10-30 2'] });
    expect(o.frontmatter(P)['tm-pin-start']).toBeUndefined();
    expect(o.frontmatter(id!)['tm-parent']).toBe('[[T]]');
    expect(items()[id!].parent).toBe(P);
  });

  it('a second child joins the last level', async () => {
    await bootParent();
    await add({ title: 'One', parent: p('T'), hours: 4 });
    const { id } = await add({ title: 'Two', parent: 'Projects/T/T.md', hours: 4 });
    expect(store.state.tiers.at(-1)).toEqual([id]);
  });

  it('undo puts everything back: note, hours, pins, level, and no folder left', async () => {
    await bootParent();
    await add({ title: 'Child', parent: p('T'), hours: 4 });
    await settle();
    await store.undo();
    await settle();
    expect(paths()).toEqual([p('T'), p('x'), p('y')]);
    expect(o.folders.has('Projects/T')).toBe(false);
    expect(items()[p('T')]).toMatchObject({ left: 14, spent: 2, pinS: D('2026-11-20') });
    expect(items()[p('T')].budget).toBeUndefined();
    expect(store.state.tiers).toEqual([[p('y')], [p('T'), p('x')], []]);
    expect(labels.at(-1)).toBe('Undid: Added Child');
    expect(store.undoLabel).toBeNull();
  });

  it('an earlier edit still undoes after the note moved and moved back', async () => {
    await bootParent();
    store.apply(setTotal(p('x'), 8));
    await add({ title: 'Child', parent: p('x'), hours: 1 });
    await settle();
    await store.undo();
    await store.undo();
    await settle();
    expect(o.frontmatter(p('x'))['tm-left']).toBe(6);
  });
});

describe('moving', () => {
  const tree = async () => {
    o.add('Projects/A/A.md', task(0, { 'tm-budget': 40 }));
    o.add('Projects/A/a1.md', task(6, { 'tm-parent': '[[A]]' }));
    o.add('Projects/A/a2.md', task(8, { 'tm-parent': '[[A]]', 'tm-pin-start': '2026-11-16' }));
    o.add('Projects/A/a3.md', task(4, { 'tm-parent': '[[A]]' }));
    o.add('Projects/B/B.md', task(0));
    o.add('Projects/B/b1.md', task(6, { 'tm-parent': '[[B]]', 'tm-deps': ['[[a1]]'] }));
    o.add('Projects/B/Sub/Sub.md', task(0, { 'tm-parent': '[[B]]' }));
    o.add('Projects/B/Sub/s1.md', task(5, { 'tm-parent': '[[Sub]]' }));
    o.add(p('solo'), task(10, { 'tm-log': ['2026-10-30 2'], 'tm-left': 8 }));
    o.add('Projects/_external/Outage.md', { 'tm-type': 'external', 'tm-pin-start': '2026-11-02', 'tm-pin-end': '2026-11-03' });
    o.add('Projects/A/m.md', { 'tm-type': 'milestone', 'tm-parent': '[[A]]' });
    o.stateJson = JSON.stringify({
      tiers: [['Projects/A/a1.md', 'Projects/A/a2.md'], ['Projects/A/a3.md', 'Projects/B/b1.md', 'Projects/B/Sub/s1.md', p('solo')]],
      plan: { 'Projects/A/a2.md': { start: '2026-11-16', end: '2026-11-18', hours: 8 } },
    });
    await boot();
  };
  const A = 'Projects/A/A.md';
  const B = 'Projects/B/B.md';
  const kidsOf = (parent: string | null) => Object.keys(items()).filter(i => items()[i].parent === parent);

  it('rewrites tm-parent and moves the note; pins, priority, deps and plans stay', async () => {
    await tree();
    const { id } = await store.move('Projects/A/a2.md', B);
    expect(id).toBe('Projects/B/a2.md');
    expect(items()[id!]).toMatchObject({ parent: B, pinS: D('2026-11-16') });
    expect(store.state.tiers[0]).toContain(id);
    expect(store.state.plan[id!]).toMatchObject({ hours: 8 });
    expect(labels).toEqual(['Moved a2']);
    await settle();
    expect(o.frontmatter(id!)['tm-parent']).toBe('[[B]]');
    expect(items()[id!].parent).toBe(B);
    expect(stateFile().plan[id!].hours).toBe(8);
    expect(items()[A].budget).toBe(40);
  });

  it('an item with children takes its folder along', async () => {
    await tree();
    const { id } = await store.move('Projects/B/Sub/Sub.md', A);
    expect(id).toBe('Projects/A/Sub/Sub.md');
    expect(o.notes.has('Projects/A/Sub/s1.md')).toBe(true);
    expect(items()['Projects/A/Sub/s1.md'].parent).toBe(id);
    expect(store.state.tiers[1]).toContain('Projects/A/Sub/s1.md');
  });

  it('into a task: its hours become its budget and its note moves first', async () => {
    await tree();
    const { id } = await store.move('Projects/A/a1.md', p('solo'));
    const solo = 'Projects/solo/solo.md';
    expect(id).toBe('Projects/solo/a1.md');
    expect(items()[solo]).toMatchObject({ budget: 10, left: 0, spent: 2 });
    expect(store.state.tiers.flat()).not.toContain(solo);
    expect(store.state.tiers[0]).toContain(id);
  });

  it('last child leaving: the budget becomes hours again, and the item takes the last level', async () => {
    await tree();
    await store.move('Projects/B/Sub/s1.md', B);
    const sub = 'Projects/B/Sub/Sub.md';
    expect(items()[sub]).toMatchObject({ left: 0 });
    store.apply(st => {
      st.items[sub].budget = 30;
      return 'budget';
    });
    await store.move(sub, A);
    await store.undo();
    expect(items()[sub].budget).toBe(30);
  });

  it('a budget comes back as hours when the last child leaves', async () => {
    o.add('Projects/P/P.md', task(0, { 'tm-budget': 20 }));
    o.add('Projects/P/c.md', task(6, { 'tm-parent': '[[P]]' }));
    o.add(p('other'), task(6));
    await boot();
    await store.move('Projects/P/c.md', null);
    expect(items()['Projects/P/P.md']).toMatchObject({ left: 20 });
    expect(items()['Projects/P/P.md'].budget).toBeUndefined();
    expect(store.state.tiers.at(-1)).toContain('Projects/P/P.md');
  });

  it('to top level makes a project', async () => {
    await tree();
    const { id } = await store.move('Projects/A/a1.md', null);
    expect(id).toBe(p('a1'));
    expect(items()[id!].parent).toBeNull();
    await settle();
    expect(o.frontmatter(id!)['tm-parent']).toBeUndefined();
  });

  it('a title clash in the new folder gets a suffix', async () => {
    await tree();
    o.add('Projects/B/a1.md', task(1, { 'tm-parent': '[[B]]' }));
    o.deliver();
    const { id } = await store.move('Projects/A/a1.md', B);
    expect(id).toBe('Projects/B/a1 2.md');
    expect(items()[id!].title).toBe('a1 2');
  });

  it('refuses, says why and touches nothing', async () => {
    await tree();
    const was = paths();
    const error = async (id: string, to: string | null) => (await store.move(id, to)).error;
    expect(await error(B, 'Projects/B/Sub/s1.md')).toMatch(/inside itself/);
    expect(await error(B, B)).toMatch(/inside itself/);
    expect(await error('Projects/A/a1.md', 'Projects/A/m.md')).toMatch(/Milestones cannot/);
    expect(await error('Projects/A/a1.md', 'Projects/_external/Outage.md')).toMatch(/External items cannot/);
    expect(await error('Projects/A/m.md', null)).toMatch(/needs a parent/);
    expect(await error('Projects/_external/Outage.md', A)).toMatch(/stay in their own/);
    expect(await error('Projects/A/a1.md', 'Projects/B/b1.md')).toMatch(/loop/);
    expect(paths()).toEqual(was);
    expect(store.undoLabel).toBeNull();
  });

  it('order among siblings holds through a reload, a rename and undo', async () => {
    await tree();
    await store.move('Projects/A/a3.md', A, 'Projects/A/a1.md');
    expect(kidsOf(A)).toEqual(['Projects/A/a3.md', 'Projects/A/a1.md', 'Projects/A/a2.md', 'Projects/A/m.md']);
    expect(paths()).toContain('Projects/A/a3.md');
    await settle();
    await store.rename('Projects/A/a3.md', 'first');
    await settle();
    expect(kidsOf(A)[0]).toBe('Projects/A/first.md');
    store.dispose();
    await boot();
    expect(kidsOf(A)[0]).toBe('Projects/A/first.md');
    store.dispose();
    await boot();
  });

  it('undo of a reorder alone', async () => {
    await tree();
    await store.move('Projects/A/a3.md', A, 'Projects/A/a1.md');
    await store.undo();
    expect(kidsOf(A)).toEqual(['Projects/A/a1.md', 'Projects/A/a2.md', 'Projects/A/a3.md', 'Projects/A/m.md']);
  });

  it('undo brings note, parent and budget back, across several moves', async () => {
    await tree();
    await store.move('Projects/A/a1.md', p('solo'));
    await settle();
    await store.move('Projects/solo/solo.md', A);
    await settle();
    expect(items()['Projects/A/solo/a1.md'].parent).toBe('Projects/A/solo/solo.md');
    await store.undo();
    await settle();
    expect(items()['Projects/solo/a1.md'].parent).toBe('Projects/solo/solo.md');
    await store.undo();
    await settle();
    expect(o.notes.has('Projects/A/a1.md')).toBe(true);
    expect(o.frontmatter('Projects/A/a1.md')['tm-parent']).toBe('[[A]]');
    expect(items()['Projects/A/a1.md'].parent).toBe(A);
    expect(items()[p('solo')]).toMatchObject({ left: 8, spent: 2 });
    expect(items()[p('solo')].budget).toBeUndefined();
    expect(o.folders.has('Projects/solo')).toBe(false);
    expect(store.undoLabel).toBeNull();
  });
});

describe('renaming', () => {
  it('renames the note; links, plan and level follow, even before the cache catches up', async () => {
    o.add(p('a'), task(6));
    o.add(p('b'), task(6, { 'tm-deps': ['[[a]]'] }));
    o.stateJson = JSON.stringify({ tiers: [[p('a'), p('b')]], plan: { [p('a')]: { start: '2026-11-02', end: '2026-11-03', hours: 6 } } });
    await boot();
    const { id } = await store.rename(p('a'), 'Renamed');
    expect(id).toBe(p('Renamed'));
    expect(items()[id!].title).toBe('Renamed');
    expect(items()[p('b')].deps).toEqual([id]);
    expect(store.state.tiers[0]).toContain(id);
    expect(store.state.plan[id!]).toBeDefined();
    expect(labels).toEqual(['Renamed a to Renamed']);
    await settle();
    expect(items()[p('b')].deps).toEqual([id]);
    expect(o.frontmatter(p('b'))['tm-deps']).toEqual(['[[Renamed]]']);
    expect(store.warnings).toEqual([]);
    await store.undo();
    await settle();
    expect(o.notes.has(p('a'))).toBe(true);
    expect(items()[p('b')].deps).toEqual([p('a')]);
    expect(store.state.plan[p('a')]).toBeDefined();
  });

  it('a parent: folder and note, children still inside', async () => {
    o.add('Projects/P/P.md', task(0));
    o.add('Projects/P/c.md', task(6, { 'tm-parent': '[[P]]' }));
    await boot();
    const { id } = await store.rename('Projects/P/P.md', 'Q');
    expect(id).toBe('Projects/Q/Q.md');
    expect(paths()).toEqual(['Projects/Q/Q.md', 'Projects/Q/c.md']);
    expect(items()['Projects/Q/c.md'].parent).toBe(id);
    await settle();
    expect(items()['Projects/Q/c.md'].parent).toBe(id);
    await store.undo();
    await settle();
    expect(paths()).toEqual(['Projects/P/P.md', 'Projects/P/c.md']);
    expect(items()['Projects/P/c.md'].parent).toBe('Projects/P/P.md');
  });

  it('a clash gets a suffix, a blank name is refused, the same name does nothing', async () => {
    o.add(p('a'), task());
    o.add(p('b'), task());
    await boot();
    expect((await store.rename(p('a'), ' ')).error).toMatch(/name/i);
    expect((await store.rename(p('a'), 'a')).id).toBe(p('a'));
    expect(store.undoLabel).toBeNull();
    expect((await store.rename(p('a'), 'b')).id).toBe(p('b 2'));
  });

  it('tells move listeners before the change goes out', async () => {
    o.add(p('a'), task());
    await boot();
    const seen: string[] = [];
    store.onMove((from, to) => seen.push(`${from}>${to}`));
    await store.rename(p('a'), 'z');
    expect(seen).toEqual([`${p('a')}>${p('z')}`]);
  });
});

describe('deleting', () => {
  const tree = async () => {
    o.add('Projects/P/P.md', task(0, { 'tm-budget': 30, 'tm-log': ['2026-10-30 2'] }));
    o.add('Projects/P/S/S.md', task(0, { 'tm-parent': '[[P]]' }));
    o.add('Projects/P/S/s1.md', task(6, { 'tm-parent': '[[S]]' }), [], '- [ ] keep me\n');
    o.add(p('other'), task(6, { 'tm-deps': ['[[s1]]', '[[S]]'] }));
    o.stateJson = JSON.stringify({
      tiers: [['Projects/P/S/s1.md'], [p('other')]],
      plan: {
        'Projects/P/P.md': { start: '2026-11-02', end: '2026-11-03', hours: 6 },
        'Projects/P/S/S.md': { start: '2026-11-02', end: '2026-11-03', hours: 6 },
        'Projects/P/S/s1.md': { start: '2026-11-02', end: '2026-11-03', hours: 6 },
      },
    });
    await boot();
  };

  it('removes the subtree, its plan and priority entries and dependencies on it, and uses the trash', async () => {
    await tree();
    await store.remove('Projects/P/S/S.md');
    expect(items()['Projects/P/S/s1.md']).toBeUndefined();
    expect(items()['Projects/P/S/S.md']).toBeUndefined();
    expect(store.state.tiers.flat()).not.toContain('Projects/P/S/s1.md');
    expect(store.state.plan['Projects/P/S/S.md']).toBeUndefined();
    expect(store.state.plan['Projects/P/S/s1.md']).toBeUndefined();
    expect(store.state.plan['Projects/P/P.md']).toBeDefined();
    expect(items()[p('other')].deps).toEqual([]);
    expect(o.trashed).toEqual(expect.arrayContaining(['Projects/P/S/S.md', 'Projects/P/S/s1.md']));
    expect(o.folders.has('Projects/P/S')).toBe(false);
    expect(labels).toEqual(['Deleted S and 1 inside it']);
    await settle();
    expect(o.frontmatter(p('other'))['tm-deps']).toEqual([]);
    expect(store.warnings).toEqual([]);
    expect(Object.keys(stateFile().plan)).toEqual(['Projects/P/P.md']);
  });

  it('the last child: the parent gets its budget back as hours and is scheduled', async () => {
    await tree();
    await store.remove('Projects/P/S/S.md');
    expect(items()['Projects/P/P.md']).toMatchObject({ left: 28, spent: 2 });
    expect(store.state.tiers.at(-1)).toContain('Projects/P/P.md');
  });

  it('undo restores notes with their text, plan, priority and dependencies', async () => {
    await tree();
    const text = o.text('Projects/P/S/s1.md');
    await store.remove('Projects/P/S/S.md');
    await settle();
    await store.undo();
    expect(items()['Projects/P/S/s1.md'].parent).toBe('Projects/P/S/S.md');
    expect(store.state.tiers[0]).toEqual(['Projects/P/S/s1.md']);
    expect(store.state.plan['Projects/P/S/s1.md']).toBeDefined();
    expect(items()[p('other')].deps).toEqual(['Projects/P/S/s1.md', 'Projects/P/S/S.md']);
    expect(labels.at(-1)).toBe('Undid: Deleted S and 1 inside it');
    await settle();
    expect(o.text('Projects/P/S/s1.md')).toBe(text);
    expect(items()['Projects/P/P.md']).toMatchObject({ left: 0, budget: 30 });
    expect(items()[p('other')].deps).toEqual(['Projects/P/S/s1.md', 'Projects/P/S/S.md']);
    expect(store.warnings).toEqual([]);
  });

  it('keeps edits still waiting to be written', async () => {
    await tree();
    store.apply(setTotal('Projects/P/S/s1.md', 9));
    await store.remove('Projects/P/S/S.md');
    await settle();
    await store.undo();
    await settle();
    expect(o.frontmatter('Projects/P/S/s1.md')['tm-left']).toBe(9);
  });

  it('undo finds the place again after the folder around it was renamed', async () => {
    await tree();
    await store.remove('Projects/P/S/S.md');
    await settle();
    await store.rename('Projects/P/P.md', 'Q');
    await settle();
    await store.undo();
    await settle();
    await store.undo();
    await settle();
    expect(items()['Projects/P/S/s1.md'].parent).toBe('Projects/P/S/S.md');
  });

  it('a failed trash rolls back and says so', async () => {
    await tree();
    const real = o.app.fileManager.trashFile;
    let calls = 0;
    o.app.fileManager.trashFile = async f => {
      if (++calls === 2) throw new Error('Trash full');
      return real(f);
    };
    const { error } = await store.remove('Projects/P/S/S.md');
    expect(error).toMatch(/Trash full/);
    await settle();
    expect(items()['Projects/P/S/s1.md'].parent).toBe('Projects/P/S/S.md');
    expect(store.undoLabel).toBeNull();
  });
});

describe('external items', () => {
  const X = 'Projects/_external/X.md';
  const bootExt = async () => {
    o.add(X, { 'tm-type': 'external', 'tm-pin-start': '2026-11-02', 'tm-pin-end': '2026-11-04' });
    o.add(p('a'), task(12));
    await boot();
  };

  it('dates are fields: changing one moves the forecast, undo moves it back', async () => {
    await bootExt();
    store.apply(addDep(p('a'), X));
    expect(analyze(store.state).by[p('a')].start).toBe(D('2026-11-05'));
    store.apply(setPin(X, 'end', D('2026-11-09')));
    expect(analyze(store.state).by[p('a')].start).toBe(D('2026-11-10'));
    await settle();
    expect(o.frontmatter(X)['tm-pin-end']).toBe('2026-11-09');
    await store.undo();
    expect(analyze(store.state).by[p('a')].start).toBe(D('2026-11-05'));
  });

  it('start cannot pass end, and the other way round', async () => {
    await bootExt();
    store.apply(setPin(X, 'start', D('2026-11-20')));
    expect(items()[X].pinS).toBe(D('2026-11-04'));
    store.apply(setPin(X, 'end', D('2026-10-20')));
    expect(items()[X].pinE).toBe(D('2026-11-04'));
  });

  it('blocks add and remove are dependencies of the blocked item', async () => {
    await bootExt();
    store.apply(addDep(p('a'), X));
    await settle();
    expect(o.frontmatter(p('a'))['tm-deps']).toEqual(['[[X]]']);
    store.apply(removeDep(p('a'), X));
    await settle();
    expect(items()[p('a')].deps).toEqual([]);
  });

  it('deleting one frees what it blocked, undo blocks it again', async () => {
    await bootExt();
    store.apply(addDep(p('a'), X));
    await settle();
    await store.remove(X);
    expect(analyze(store.state).by[p('a')].start).toBe(D('2026-11-02'));
    await store.undo();
    expect(analyze(store.state).by[p('a')].start).toBe(D('2026-11-05'));
  });
});

describe('linked notes', () => {
  it('link and unlink write tm-notes and undo', async () => {
    o.add(p('a'), task());
    o.add('Elsewhere/call.md');
    await boot();
    store.apply(linkNote(p('a'), 'Elsewhere/call.md'));
    expect(items()[p('a')].notes).toEqual(['Elsewhere/call.md']);
    await settle();
    expect(o.frontmatter(p('a'))['tm-notes']).toEqual(['[[call]]']);
    store.apply(unlinkNote(p('a'), 'Elsewhere/call.md'));
    await settle();
    expect(o.frontmatter(p('a'))['tm-notes']).toEqual([]);
    await store.undo();
    await settle();
    expect(items()[p('a')].notes).toEqual(['Elsewhere/call.md']);
  });

  it('linking a note that does not exist creates it where new notes go', async () => {
    o.add(p('a'), task());
    o.folders.add('Inbox');
    o.newNotesFolder = 'Inbox';
    await boot();
    const { id } = await store.linkNew(p('a'), 'Vendor call');
    expect(id).toBe('Inbox/Vendor call.md');
    expect(o.notes.has(id!)).toBe(true);
    expect(items()[p('a')].notes).toEqual([id]);
    await settle();
    expect(o.frontmatter(p('a'))['tm-notes']).toEqual(['[[Vendor call]]']);
    await store.undo();
    await settle();
    expect(o.notes.has(id!)).toBe(false);
    expect(items()[p('a')].notes).toEqual([]);
  });
});

describe('a note created at the vault root', () => {
  it('has a plain path: Obsidian calls the root /', async () => {
    o.add(p('a'), task());
    await boot();
    expect((await store.linkNew(p('a'), 'Loose')).id).toBe('Loose.md');
  });
});

describe('undo across renames', () => {
  it('a group: an edit made before a rename lands on the note after the rename is undone', async () => {
    o.add(p('a'), task(12));
    await boot();
    await store.group('Both', async () => {
      store.apply(setTotal(p('a'), 9));
      await store.rename(p('a'), 'b');
    });
    await settle();
    expect(o.frontmatter(p('b'))['tm-left']).toBe(9);
    await store.undo();
    await settle();
    expect(o.frontmatter(p('a'))['tm-left']).toBe(12);
  });

  it('a deleted note comes back under a folder someone renamed in the meantime', async () => {
    o.add('Projects/P/P.md', task(0));
    o.add('Projects/P/c.md', task(6, { 'tm-parent': '[[P]]' }));
    o.add('Projects/P/d.md', task(6, { 'tm-parent': '[[P]]' }));
    await boot();
    await store.remove('Projects/P/c.md');
    await settle();
    o.renameFolder('Projects/P', 'Projects/Q');
    await settle();
    await store.undo();
    await settle();
    expect(paths()).toContain('Projects/Q/c.md');
    expect(paths()).not.toContain('Projects/P/c.md');
  });
});

describe('the cache getting there first', () => {
  it('a recompute between the new note and its edit still makes the parent adopt it', async () => {
    o.add(p('T'), task(6));
    await boot();
    const real = o.app.vault.create;
    o.app.vault.create = async (path, data) => {
      const file = await real(path, data);
      o.deliver();
      await vi.advanceTimersByTimeAsync(100);
      return file;
    };
    await add({ title: 'One', parent: p('T'), hours: 1 });
    expect(items()['Projects/T/T.md']).toMatchObject({ budget: 6, left: 0 });
  });
});

describe('one at a time', () => {
  it('a second add inside a brand-new parent finds it at its new path', async () => {
    o.add(p('T'), task(6));
    await boot();
    const [one, two] = await Promise.all([add({ title: 'One', parent: p('T'), hours: 1 }), add({ title: 'Two', parent: p('T'), hours: 1 })]);
    expect(one.id).toBe('Projects/T/One.md');
    expect(two.id).toBe('Projects/T/Two.md');
    expect(items()[two.id!].parent).toBe('Projects/T/T.md');
  });

  it('Ctrl+Z pressed twice undoes two steps in order', async () => {
    o.add(p('T'), task(6));
    await boot();
    await add({ title: 'One', parent: p('T'), hours: 1 });
    await add({ title: 'Two', parent: 'Projects/T/T.md', hours: 1 });
    await Promise.all([store.undo(), store.undo()]);
    await settle();
    expect(paths()).toEqual([p('T')]);
  });
});

describe('where a new item lands', () => {
  it('last among its siblings, so existing projects keep their colour, through a reload', async () => {
    o.add(p('Beta'), task());
    o.add(p('Gamma'), task());
    await boot();
    await add({ title: 'Alpha', hours: 1 });
    const roots = () => Object.keys(items()).filter(i => !items()[i].parent);
    expect(roots()).toEqual([p('Beta'), p('Gamma'), p('Alpha')]);
    await settle();
    expect(roots()).toEqual([p('Beta'), p('Gamma'), p('Alpha')]);
    await store.flush();
    store.dispose();
    await boot();
    expect(roots()).toEqual([p('Beta'), p('Gamma'), p('Alpha')]);
  });
});
