import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyze, dayOf as D, kids } from '../../src/engine';
import { editLogEntry, logHours, setHoursLeft, STATE_PATH, TaskmasterStore } from '../../src/store';
import { STATE_BAD } from '../../src/store/state-file';
import { FakeObsidian } from './fake-obsidian';

const p = (name: string) => `Projects/${name}.md`;
const task = (left: number, extra = {}) => ({ 'tm-type': 'item', 'tm-estimate': left, 'tm-left': left, ...extra });
const NOV2 = D('2026-11-02');

let o: FakeObsidian;
let store: TaskmasterStore;
let today: number;

const boot = async () => {
  store = new TaskmasterStore(o.app, { today: () => today, debounceMs: 100, writeMs: 300 });
  await store.load();
  await vi.advanceTimersByTimeAsync(0);
};
const settle = async () => {
  await vi.advanceTimersByTimeAsync(300);
  o.deliver();
  await vi.advanceTimersByTimeAsync(100);
  o.deliver();
  await vi.advanceTimersByTimeAsync(100);
};

beforeEach(() => {
  vi.useFakeTimers();
  o = new FakeObsidian();
  o.folders.add('Projects');
  today = NOV2;
});

afterEach(() => {
  store?.dispose();
  vi.useRealTimers();
});

describe('a finished task keeps its done date', () => {
  it('a later log edit that leaves it finished does not move the date', async () => {
    o.add(p('a'), { 'tm-type': 'item', 'tm-left': 0, 'tm-left-updated': '2026-10-20', 'tm-log': ['2026-10-19 4'] });
    await boot();
    expect(store.state.items[p('a')].doneOn).toBe(D('2026-10-20'));
    store.apply(editLogEntry(p('a'), 0, 6));
    await settle();
    expect(store.state.items[p('a')].doneOn).toBe(D('2026-10-20'));
    expect(o.frontmatter(p('a'))['tm-left-updated']).toBe('2026-10-20');
    expect(o.frontmatter(p('a'))['tm-log']).toEqual(['2026-10-19 6']);
  });

  it('a date only the log gave stays when more is logged later', async () => {
    o.add(p('a'), { 'tm-type': 'item', 'tm-left': 0, 'tm-log': ['2026-10-19 4'] });
    await boot();
    store.apply(logHours(p('a'), NOV2, 1));
    await settle();
    expect(store.state.items[p('a')].doneOn).toBe(D('2026-10-19'));
  });

  it('reopening still moves the update date', async () => {
    o.add(p('a'), { 'tm-type': 'item', 'tm-left': 0, 'tm-left-updated': '2026-10-20', 'tm-log': ['2026-10-19 4'] });
    await boot();
    store.apply(setHoursLeft(p('a'), 2));
    await settle();
    expect(store.state.items[p('a')].doneOn).toBeUndefined();
    expect(o.frontmatter(p('a'))['tm-left-updated']).toBe('2026-11-02');
  });
});

describe('logging more than is left', () => {
  it('counts as real work: left floors at 0 and the total rises', async () => {
    o.add(p('a'), task(2));
    await boot();
    store.apply(logHours(p('a'), NOV2, 5));
    const it = store.state.items[p('a')];
    expect(it.left).toBe(0);
    expect(it.spent).toBe(5);
    expect(analyze(store.state).results[p('a')]).toMatchObject({ spent: 5, left: 0 });
  });

  it('is refused on a draft: hours go on tasks', async () => {
    o.add(p('a'), { 'tm-type': 'item' });
    await boot();
    expect(store.apply(logHours(p('a'), NOV2, 1))).toBe(false);
    expect(store.state.items[p('a')].log ?? []).toEqual([]);
  });
});

describe('state.json is never lost', () => {
  const failingRead = () => {
    const { adapter } = o.app.vault;
    adapter.read = async () => {
      throw new Error('EIO');
    };
  };

  it('a file that cannot be read is copied aside before anything overwrites it', async () => {
    o.add(p('a'), task(6));
    o.stateJson = '{"capacity": 12}';
    failingRead();
    await boot();
    expect(store.warnings.map(w => w.msg).join()).toContain(STATE_BAD);
    store.apply(setHoursLeft(p('a'), 3));
    await settle();
    await store.flush();
    expect(o.files.get(STATE_BAD)).toBe('{"capacity": 12}');
  });

  it('with no copy possible, nothing overwrites it, and the user is told', async () => {
    o.add(p('a'), task(6));
    o.stateJson = '{"capacity": 12}';
    failingRead();
    const { adapter } = o.app.vault;
    adapter.copy = async () => {
      throw new Error('EROFS');
    };
    await boot();
    expect(store.warnings.map(w => w.msg).join()).toContain('not be saved');
    store.apply(s => {
      s.settings.weekly = 20;
      return 'Capacity';
    });
    await settle();
    await store.flush();
    expect(o.stateJson).toBe('{"capacity": 12}');
  });

  it('broken JSON that cannot be copied aside is not overwritten either', async () => {
    o.add(p('a'), task(6));
    o.stateJson = '{ broken';
    const { adapter } = o.app.vault;
    const write = adapter.write;
    adapter.write = async (path, data) => {
      if (path === STATE_BAD) throw new Error('EROFS');
      return write(path, data);
    };
    await boot();
    store.apply(s => {
      s.settings.weekly = 20;
      return 'Capacity';
    });
    await settle();
    await store.flush();
    expect(o.stateJson).toBe('{ broken');
  });

  it('what a load skipped survives the next save', async () => {
    o.add(p('a'), task(6));
    o.stateJson = JSON.stringify({
      capacity: 'lots',
      plan: { [p('a')]: { start: 'soon' } },
      holidays: ['2026-12-24', 'xmas'],
      weekCapacity: { nonsense: 3 },
      futureField: { keep: true },
    });
    await boot();
    expect(store.warnings.length).toBeGreaterThan(0);
    store.apply(s => {
      s.settings.staleDays = 9;
      return 'Stale';
    });
    await settle();
    await store.flush();
    const saved = JSON.parse(o.stateJson!);
    expect(saved.staleDays).toBe(9);
    expect(saved.holidays).toEqual(['2026-12-24']);
    expect(saved.futureField).toEqual({ keep: true });
    expect(saved.skipped).toEqual({ capacity: ['lots'], plan: [{ [p('a')]: { start: 'soon' } }], holidays: ['xmas'], weekCapacity: [{ nonsense: 3 }] });
  });

  it('what was skipped before stays through another load and save', async () => {
    o.add(p('a'), task(6));
    o.stateJson = JSON.stringify({ skipped: { capacity: ['lots'] } });
    await boot();
    store.apply(s => {
      s.settings.staleDays = 9;
      return 'Stale';
    });
    await settle();
    await store.flush();
    expect(JSON.parse(o.stateJson!).skipped).toEqual({ capacity: ['lots'] });
  });
});

describe('undo finishes what it can', () => {
  it('a failing step leaves the others done, and says so', async () => {
    o.add(p('a'), task(6));
    await boot();
    const did: string[] = [];
    const labels: (string | undefined)[] = [];
    store.subscribe((_, l) => labels.push(l));
    await store.group('Three things', () => {
      store.record({ label: '1', undo: () => void did.push('1') });
      store.record({
        label: '2',
        undo: () => {
          throw new Error('disk gone');
        },
      });
      store.record({ label: '3', undo: () => void did.push('3') });
    });
    await store.undo();
    expect(did).toEqual(['3', '1']);
    expect(store.warnings.map(w => w.msg).join()).toContain('disk gone');
  });

  it('deleting a subtree: one note that will not come back does not cost the others', async () => {
    o.add('Projects/P/P.md', task(0));
    o.add('Projects/P/a.md', task(6, { 'tm-parent': '[[P]]' }));
    o.add('Projects/P/b.md', task(6, { 'tm-parent': '[[P]]' }));
    await boot();
    await store.remove('Projects/P/P.md');
    await settle();
    const { create } = o.app.vault;
    o.app.vault.create = (path, data) => (path === 'Projects/P/a.md' ? Promise.reject(new Error('nope')) : create(path, data));
    await store.undo();
    await settle();
    expect(o.notes.has('Projects/P/P.md')).toBe(true);
    expect(o.notes.has('Projects/P/b.md')).toBe(true);
    expect(store.warnings.map(w => w.msg).join()).toContain('nope');
  });
});

describe('new titles cannot capture links', () => {
  it('a title used anywhere in the vault gets a number, in any case', async () => {
    o.add('Elsewhere/alpha.md');
    await boot();
    const { id } = await store.create({ kind: 'item', title: 'Alpha', hours: 2 });
    expect(id).toBe(p('Alpha 2'));
  });

  it('a bare link keeps its note when a shorter path would have taken it over', async () => {
    o.add('Projects/P/P.md', task(0));
    o.add('Projects/P/deep/T.md', task(3, { 'tm-parent': '[[P]]' }));
    o.add('Projects/Q/Q.md', task(0));
    o.add('Projects/Q/x.md', task(3, { 'tm-parent': '[[Q]]', 'tm-deps': ['[[T]]'] }));
    await boot();
    await store.create({ kind: 'item', title: 'T', hours: 1 });
    await settle();
    expect(store.state.items['Projects/Q/x.md'].deps).toEqual(['Projects/P/deep/T.md']);
  });

  it('renaming onto a title used elsewhere numbers it too', async () => {
    o.add('Notes/Taken.md');
    o.add(p('a'), task(3));
    await boot();
    const { id } = await store.rename(p('a'), 'Taken');
    expect(id).toBe(p('Taken 2'));
  });

  it('a move keeps a title it already has, even one used elsewhere', async () => {
    o.add('Notes/Same.md');
    o.add(p('Same'), task(3));
    o.add(p('P'), task(4));
    await boot();
    const { id } = await store.move(p('Same'), p('P'));
    expect(id).toBe('Projects/P/Same.md');
  });
});

describe('the last child trashed outside the plugin', () => {
  const family = () => {
    o.add('Projects/P/P.md', { 'tm-type': 'item', 'tm-budget': 20, 'tm-left': 0 });
    o.add('Projects/P/c.md', task(6, { 'tm-parent': '[[P]]' }));
  };

  it('gives the parent its hours back, on disk too', async () => {
    family();
    await boot();
    o.remove('Projects/P/c.md');
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(store.state.items['Projects/P/P.md']).toMatchObject({ left: 20 });
    expect(store.state.items['Projects/P/P.md'].budget).toBeUndefined();
    expect(o.frontmatter('Projects/P/P.md')).toMatchObject({ 'tm-left': 20 });
    expect(o.frontmatter('Projects/P/P.md')['tm-budget']).toBeUndefined();
    expect(store.state.tiers.flat()).toContain('Projects/P/P.md');
  });

  it('leaves a parent that still has children alone', async () => {
    family();
    o.add('Projects/P/d.md', task(2, { 'tm-parent': '[[P]]' }));
    await boot();
    o.remove('Projects/P/c.md');
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(store.state.items['Projects/P/P.md'].budget).toBe(20);
    expect(kids(store.state)['Projects/P/P.md']).toEqual(['Projects/P/d.md']);
  });

  it('a whole folder gone at once costs nothing', async () => {
    family();
    await boot();
    o.removeFolder('Projects/P');
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(store.state.items).toEqual({});
    expect(store.warnings).toEqual([]);
  });

  it('deleting through the plugin stays one undoable step', async () => {
    family();
    await boot();
    await store.remove('Projects/P/c.md');
    await settle();
    expect(store.state.items['Projects/P/P.md']).toMatchObject({ left: 20 });
    await store.undo();
    await settle();
    expect(store.state.items['Projects/P/P.md']).toMatchObject({ budget: 20, left: 0 });
    expect(store.undoLabel).toBeNull();
  });
});

describe('a note with an unknown tm-type', () => {
  it('is left out, with its warning', async () => {
    o.add(p('odd'), { 'tm-type': 'task', 'tm-left': 3 });
    o.add(p('a'), task(3));
    await boot();
    expect(store.state.items[p('odd')]).toBeUndefined();
    expect(store.warnings).toMatchObject([{ path: p('odd'), field: 'tm-type' }]);
  });
});

describe('path keys', () => {
  it('sibling order follows a rename into state.json', async () => {
    o.add(p('a'), { 'tm-type': 'item' });
    o.add(p('b'), { 'tm-type': 'item' });
    await boot();
    await store.move(p('b'), null, p('a'));
    await settle();
    await store.flush();
    expect(JSON.parse(o.stateJson!).order).toEqual([p('b'), p('a')]);
    o.rename(p('b'), p('c'));
    await settle();
    await store.flush();
    expect(JSON.parse(o.files.get(STATE_PATH)!).order).toEqual([p('c'), p('a')]);
  });
});

describe('timer stops past the hours left', () => {
  it('reopening goes to the last priority level', async () => {
    o.add(p('short'), task(1));
    o.add(p('a'), task(3));
    o.add(p('b'), task(3));
    o.stateJson = JSON.stringify({ tiers: [[p('short')], [p('a'), p('b')]] });
    await boot();
    store.apply(logHours(p('short'), NOV2, 2));
    expect(store.state.tiers.flat()).not.toContain(p('short'));
    store.apply(setHoursLeft(p('short'), 3));
    await settle();
    expect(store.state.tiers).toEqual([[], [p('a'), p('b'), p('short')]]);
  });
});
