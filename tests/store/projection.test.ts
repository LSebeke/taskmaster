import { beforeEach, describe, expect, it } from 'vitest';
import { analyze, dayOf as D } from '../../src/engine';
import { TaskmasterStore } from '../../src/store';
import { FakeObsidian } from './fake-obsidian';

const today = D('2026-11-02');
let o: FakeObsidian;

const boot = async (projectsFolder?: string) => {
  const store = new TaskmasterStore(o.app, { today: () => today, projectsFolder });
  await store.load();
  return store;
};

beforeEach(() => {
  o = new FakeObsidian();
});

describe('projection of a note', () => {
  it('turns the spec example note into an engine item keyed by path', async () => {
    o.add('Projects/Gateway/Firmware/Drivers/Drivers.md', { 'tm-type': 'item', 'tm-budget': 90 });
    o.add('Projects/Gateway/Firmware/Drivers/CAN transceiver debug.md', { 'tm-type': 'item', 'tm-left': 5 });
    o.add('Projects/Vendor call notes.md');
    const path = 'Projects/Gateway/Firmware/Drivers/CAN stack port.md';
    o.add(path, {
      'tm-type': 'item',
      'tm-parent': '[[Drivers]]',
      'tm-deps': ['[[CAN transceiver debug]]'],
      'tm-estimate': 30,
      'tm-left': 22,
      'tm-left-updated': '2026-11-02',
      'tm-log': ['2026-11-02 3.5', '2026-11-03 4'],
      'tm-started': '2026-11-02',
      'tm-pin-start': '2026-11-16',
      'tm-pin-end': '2026-11-18',
      'tm-scope': 'should',
      'tm-notes': ['[[Vendor call notes]]'],
      'tm-deadline': '2026-12-01',
    });

    const { state } = await boot();

    expect(state.items[path]).toEqual({
      title: 'CAN stack port',
      parent: 'Projects/Gateway/Firmware/Drivers/Drivers.md',
      kind: 'item',
      scope: 'should',
      deps: ['Projects/Gateway/Firmware/Drivers/CAN transceiver debug.md'],
      notes: ['Projects/Vendor call notes.md'],
      todos: [],
      est: 30,
      left: 22,
      spent: 7.5,
      touched: D('2026-11-02'),
      log: [
        { d: D('2026-11-02'), h: 3.5 },
        { d: D('2026-11-03'), h: 4 },
      ],
      actualStart: D('2026-11-02'),
      pinS: D('2026-11-16'),
      pinE: D('2026-11-18'),
      deadline: D('2026-12-01'),
    });
    expect(state.items['Projects/Gateway/Firmware/Drivers/Drivers.md'].budget).toBe(90);
  });
});

const pos = (offset: number, length: number) => ({
  position: { start: { line: 0, col: 0, offset }, end: { line: 0, col: length, offset: offset + length } },
});

describe('which notes are items', () => {
  it('takes notes with tm-type under the projects folder only', async () => {
    o.add('Projects/a.md', { 'tm-type': 'item' });
    o.add('Projects/_external/x.md', { 'tm-type': 'external', 'tm-pin-start': '2026-11-02', 'tm-pin-end': '2026-11-03' });
    o.add('Projects/plain note.md', { tags: ['x'] });
    o.add('Projects/no frontmatter.md');
    o.add('Projects old/b.md', { 'tm-type': 'item' });
    o.add('Elsewhere/c.md', { 'tm-type': 'item' });
    expect(Object.keys((await boot()).state.items)).toEqual(['Projects/_external/x.md', 'Projects/a.md']);
  });

  it('honours a custom projects folder', async () => {
    o.add('Work/a.md', { 'tm-type': 'item' });
    o.add('Projects/b.md', { 'tm-type': 'item' });
    expect(Object.keys((await boot('Work')).state.items)).toEqual(['Work/a.md']);
  });

  it('reads nothing but the cache at boot', async () => {
    o.add('Projects/a.md', { 'tm-type': 'item', 'tm-left': 1 }, [{ task: ' ', ...pos(0, 9) }], '- [ ] one');
    await boot();
    expect(o.reads).toEqual([]);
  });
});

describe('derived fields', () => {
  it('treats a note with no hours as a draft in the must scope', async () => {
    o.add('Projects/a.md', { 'tm-type': 'item' });
    const { state } = await boot();
    expect(state.items['Projects/a.md']).toMatchObject({ left: 0, spent: 0, scope: 'must' });
    expect(analyze(state).by['Projects/a.md'].draft).toBe(true);
  });

  it('dates a finished task from tm-left-updated', async () => {
    o.add('Projects/a.md', { 'tm-type': 'item', 'tm-left': 0, 'tm-left-updated': '2026-10-20', 'tm-log': ['2026-10-19 2'] });
    expect((await boot()).state.items['Projects/a.md'].doneOn).toBe(D('2026-10-20'));
  });

  it('falls back to the last log entry for the done date', async () => {
    o.add('Projects/a.md', { 'tm-type': 'item', 'tm-left': 0, 'tm-log': ['2026-10-19 2', '2026-10-21 1'] });
    const { state } = await boot();
    expect(state.items['Projects/a.md'].doneOn).toBe(D('2026-10-21'));
    expect(analyze(state).by['Projects/a.md']).toMatchObject({ done: true, end: D('2026-10-21') });
  });

  it('does not date an unfinished task', async () => {
    o.add('Projects/a.md', { 'tm-type': 'item', 'tm-left': 3, 'tm-left-updated': '2026-10-20' });
    expect((await boot()).state.items['Projects/a.md'].doneOn).toBeUndefined();
  });

  it('reads a milestone: no hours, pin, recorded pass', async () => {
    o.add('Projects/p.md', { 'tm-type': 'item' });
    o.add('Projects/m.md', {
      'tm-type': 'milestone',
      'tm-parent': '[[p]]',
      'tm-pin-end': '2026-11-20',
      'tm-done': '2026-11-20',
      'tm-left': 5,
    });
    const m = (await boot()).state.items['Projects/m.md'];
    expect(m).toMatchObject({ kind: 'ms', pinE: D('2026-11-20'), done: true, doneOn: D('2026-11-20') });
    expect(m.left).toBeUndefined();
  });

  it('accepts a milestone date in tm-pin-start, its only pin', async () => {
    o.add('Projects/p.md', { 'tm-type': 'item' });
    o.add('Projects/m.md', { 'tm-type': 'milestone', 'tm-parent': '[[p]]', 'tm-pin-start': '2026-11-20' });
    const m = (await boot()).state.items['Projects/m.md'];
    expect(m.pinE).toBe(D('2026-11-20'));
    expect(m.pinS).toBeUndefined();
  });

  it('feeds an external dependency to the scheduler: a 12h on external 2 to 4 Nov starts Thu 5 Nov', async () => {
    o.add('Projects/_external/x.md', { 'tm-type': 'external', 'tm-pin-start': '2026-11-02', 'tm-pin-end': '2026-11-04' });
    o.add('Projects/a.md', { 'tm-type': 'item', 'tm-left': 12, 'tm-deps': ['[[x]]'] });
    const { state } = await boot();
    expect(state.items['Projects/_external/x.md']).toMatchObject({ kind: 'ext', parent: null, deps: [] });
    expect(analyze(state).by['Projects/a.md'].start).toBe(D('2026-11-05'));
  });
});

describe('to-dos', () => {
  const body = '- [ ] Check choke\n- plain bullet\n- [x] Scope it\n- [/] Half way';
  const listItems = [
    { task: ' ', ...pos(0, 17) },
    { ...pos(18, 14) },
    { task: 'x', ...pos(33, 14) },
    { task: '/', ...pos(48, 16) },
  ];

  it('come from cache listItems; any mark but a space counts as done', async () => {
    o.add('Projects/a.md', { 'tm-type': 'item' }, listItems, body);
    expect((await boot()).state.items['Projects/a.md'].todos!.map(t => t.done)).toEqual([false, true, true]);
  });

  it('get their text on demand, since the cache has none', async () => {
    o.add('Projects/a.md', { 'tm-type': 'item' }, listItems, body);
    const store = await boot();
    expect(await store.readTodos('Projects/a.md')).toEqual([
      { t: 'Check choke', done: false },
      { t: 'Scope it', done: true },
      { t: 'Half way', done: true },
    ]);
    expect(await store.readTodos('Projects/gone.md')).toEqual([]);
  });
});

describe('malformed frontmatter', () => {
  it.each([
    ['tm-left', 'lots'],
    ['tm-left', -3],
    ['tm-estimate', '30'],
    ['tm-budget', {}],
    ['tm-deadline', 'soon'],
    ['tm-deadline', '2026-02-31'],
    ['tm-pin-start', 42],
    ['tm-started', '2026-13-01'],
    ['tm-scope', 'maybe'],
    ['tm-log', 5],
    ['tm-deps', 5],
    ['tm-deps', [['nested']]],
    ['tm-parent', 7],
    ['tm-notes', [null]],
  ])('skips %s = %j and warns', async (field, value) => {
    o.add('Projects/a.md', { 'tm-type': 'item', 'tm-estimate': 8, [field]: value });
    const store = await boot();
    expect(store.state.items['Projects/a.md'].title).toBe('a');
    expect(store.warnings).toContainEqual(expect.objectContaining({ path: 'Projects/a.md', field }));
    expect(() => analyze(store.state)).not.toThrow();
  });

  it('keeps good log entries around a bad one', async () => {
    o.add('Projects/a.md', { 'tm-type': 'item', 'tm-log': ['2026-11-02 3', 'yesterday 2', 7, '2026-11-03 x', '2026-11-04 1.5'] });
    const store = await boot();
    expect(store.state.items['Projects/a.md'].spent).toBe(4.5);
    expect(store.warnings.filter(w => w.field === 'tm-log')).toHaveLength(3);
  });

  it('falls back to a plain item on an unknown tm-type', async () => {
    o.add('Projects/a.md', { 'tm-type': 'epic' });
    const store = await boot();
    expect(store.state.items['Projects/a.md'].kind).toBe('item');
    expect(store.warnings).toContainEqual(expect.objectContaining({ field: 'tm-type' }));
  });

  it('reads a lone link as a list of one', async () => {
    o.add('Projects/x.md', { 'tm-type': 'item' });
    o.add('Projects/a.md', { 'tm-type': 'item', 'tm-deps': '[[x]]' });
    const store = await boot();
    expect(store.state.items['Projects/a.md'].deps).toEqual(['Projects/x.md']);
    expect(store.warnings).toEqual([]);
  });

  it('resolves aliased and heading links', async () => {
    o.add('Projects/x.md', { 'tm-type': 'item' });
    o.add('Projects/a.md', { 'tm-type': 'item', 'tm-parent': '[[x#Heading|shown]]', 'tm-deps': ['[[x|shown]]'] });
    const { state } = await boot();
    expect(state.items['Projects/a.md']).toMatchObject({ parent: 'Projects/x.md', deps: [] });
  });
});

describe('broken links and shapes', () => {
  it('makes an item with a dangling parent a project, and warns', async () => {
    o.add('Projects/a.md', { 'tm-type': 'item', 'tm-parent': '[[gone]]' });
    const store = await boot();
    expect(store.state.items['Projects/a.md'].parent).toBeNull();
    expect(store.warnings).toContainEqual(expect.objectContaining({ field: 'tm-parent' }));
  });

  it('drops links to notes that are not items, and warns', async () => {
    o.add('Projects/plain.md');
    o.add('Projects/a.md', { 'tm-type': 'item', 'tm-parent': '[[plain]]', 'tm-deps': ['[[plain]]'] });
    const store = await boot();
    expect(store.state.items['Projects/a.md']).toMatchObject({ parent: null, deps: [] });
    expect(store.warnings.map(w => w.field).sort()).toEqual(['tm-deps', 'tm-parent']);
  });

  it('refuses milestones and externals as parents', async () => {
    o.add('Projects/p.md', { 'tm-type': 'item' });
    o.add('Projects/m.md', { 'tm-type': 'milestone', 'tm-parent': '[[p]]' });
    o.add('Projects/x.md', { 'tm-type': 'external', 'tm-pin-start': '2026-11-02', 'tm-pin-end': '2026-11-03' });
    o.add('Projects/a.md', { 'tm-type': 'item', 'tm-parent': '[[m]]' });
    o.add('Projects/b.md', { 'tm-type': 'item', 'tm-parent': '[[x]]' });
    const store = await boot();
    expect(store.state.items['Projects/a.md'].parent).toBeNull();
    expect(store.state.items['Projects/b.md'].parent).toBeNull();
    expect(store.warnings.filter(w => w.field === 'tm-parent')).toHaveLength(2);
  });

  it('warns about a milestone with no parent', async () => {
    o.add('Projects/m.md', { 'tm-type': 'milestone' });
    const store = await boot();
    expect(store.warnings).toContainEqual(expect.objectContaining({ path: 'Projects/m.md', field: 'tm-parent' }));
  });

  it('ignores parent and dependencies on an external item', async () => {
    o.add('Projects/p.md', { 'tm-type': 'item' });
    o.add('Projects/x.md', {
      'tm-type': 'external',
      'tm-pin-start': '2026-11-02',
      'tm-pin-end': '2026-11-03',
      'tm-parent': '[[p]]',
      'tm-deps': ['[[p]]'],
    });
    const store = await boot();
    expect(store.state.items['Projects/x.md']).toMatchObject({ parent: null, deps: [] });
    expect(store.warnings.map(w => w.field).sort()).toEqual(['tm-deps', 'tm-parent']);
  });

  it.each([
    ['no end', { 'tm-pin-start': '2026-11-02' }],
    ['end before start', { 'tm-pin-start': '2026-11-05', 'tm-pin-end': '2026-11-02' }],
  ])('leaves out an external item with %s, and whatever pointed at it survives', async (_, pins) => {
    o.add('Projects/x.md', { 'tm-type': 'external', ...pins });
    o.add('Projects/a.md', { 'tm-type': 'item', 'tm-left': 6, 'tm-deps': ['[[x]]'] });
    const store = await boot();
    expect(store.state.items['Projects/x.md']).toBeUndefined();
    expect(store.state.items['Projects/a.md'].deps).toEqual([]);
    expect(store.warnings).toContainEqual(expect.objectContaining({ path: 'Projects/x.md' }));
    expect(() => analyze(store.state)).not.toThrow();
  });

  it('breaks a parent cycle', async () => {
    o.add('Projects/a.md', { 'tm-type': 'item', 'tm-parent': '[[b]]', 'tm-left': 6 });
    o.add('Projects/b.md', { 'tm-type': 'item', 'tm-parent': '[[a]]' });
    o.add('Projects/c.md', { 'tm-type': 'item', 'tm-parent': '[[c]]' });
    const store = await boot();
    expect(store.state.items['Projects/a.md'].parent).toBeNull();
    expect(store.state.items['Projects/b.md'].parent).toBe('Projects/a.md');
    expect(store.state.items['Projects/c.md'].parent).toBeNull();
    expect(store.warnings.filter(w => w.field === 'tm-parent')).toHaveLength(2);
    expect(() => analyze(store.state)).not.toThrow();
  });

  it('breaks a dependency cycle, keeping the first links', async () => {
    o.add('Projects/a.md', { 'tm-type': 'item', 'tm-left': 6, 'tm-deps': ['[[b]]'] });
    o.add('Projects/b.md', { 'tm-type': 'item', 'tm-left': 6, 'tm-deps': ['[[a]]'] });
    const store = await boot();
    expect(store.state.items['Projects/a.md'].deps).toEqual(['Projects/b.md']);
    expect(store.state.items['Projects/b.md'].deps).toEqual([]);
    expect(store.warnings).toContainEqual(expect.objectContaining({ path: 'Projects/b.md', field: 'tm-deps' }));
    expect(analyze(store.state).by['Projects/a.md'].end).not.toBeNull();
  });
});
