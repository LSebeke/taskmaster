import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayOf as D, type State } from '../../src/engine';
import { setTotal, TaskmasterStore } from '../../src/store';
import { FakeObsidian } from './fake-obsidian';

const WRITE = 300;
const A = 'Projects/a.md';
const BODY = 'Intro\n\n- [ ] One\n- [x] Two\n\nOutro\n';
const listed = [
  { task: ' ', position: { start: { offset: 7 }, end: { offset: 16 } } },
  { task: 'x', position: { start: { offset: 17 }, end: { offset: 26 } } },
];

let o: FakeObsidian;
let store: TaskmasterStore;
let events: { state: State; label?: string }[];

const boot = async (body = BODY, list: unknown[] = listed) => {
  o.add(A, { 'tm-type': 'item', 'tm-left': 6 }, list, body);
  store = new TaskmasterStore(o.app, { today: () => D('2026-11-02'), debounceMs: 100, writeMs: WRITE });
  await store.load();
  await vi.advanceTimersByTimeAsync(0);
  events = [];
  store.subscribe((state, label) => events.push({ state, label }));
};
const bodyOf = (path = A) => o.notes.get(path)!.body;
const openCount = (path = A) => store.state.items[path].todos!.filter(t => !t.done).length;
const passWrite = () => vi.advanceTimersByTimeAsync(WRITE);
const settle = async () => {
  await passWrite();
  o.deliver();
  await vi.advanceTimersByTimeAsync(100);
};

beforeEach(() => {
  vi.useFakeTimers();
  o = new FakeObsidian();
});

afterEach(() => {
  store.dispose();
  vi.useRealTimers();
});

describe('ticking a to-do', () => {
  it('shows at once and writes the checkbox to the note, debounced', async () => {
    await boot();
    store.setTodoDone(A, 0, 'One', true);
    expect(openCount()).toBe(0);
    expect(events.at(-1)?.label).toMatch(/One/);
    expect(bodyOf()).toBe(BODY);
    await passWrite();
    expect(bodyOf()).toBe('Intro\n\n- [x] One\n- [x] Two\n\nOutro\n');
  });

  it('holds through the cache catching up, with no second event', async () => {
    await boot();
    store.setTodoDone(A, 0, 'One', true);
    const seen = events.length;
    await passWrite();
    expect(openCount()).toBe(0);
    o.deliver();
    await vi.advanceTimersByTimeAsync(100);
    expect(openCount()).toBe(0);
    expect(events).toHaveLength(seen);
  });

  it('unticks too', async () => {
    await boot();
    store.setTodoDone(A, 1, 'Two', false);
    expect(openCount()).toBe(2);
    await passWrite();
    expect(bodyOf()).toBe(BODY.replace('[x] Two', '[ ] Two'));
  });
});

describe('adding a to-do', () => {
  it('goes after the last to-do, unticked, and shows at once with its text', async () => {
    await boot();
    expect(store.addTodo(A, '  Three ')).toBe(true);
    expect(openCount()).toBe(2);
    expect(store.state.items[A].todos!.at(-1)).toEqual({ t: '', done: false });
    expect(await store.readTodos(A)).toEqual([
      { t: 'One', done: false },
      { t: 'Two', done: true },
      { t: 'Three', done: false },
    ]);
    await passWrite();
    expect(bodyOf()).toBe('Intro\n\n- [ ] One\n- [x] Two\n- [ ] Three\n\nOutro\n');
  });

  it('reads right between the write and the cache catching up', async () => {
    await boot();
    store.addTodo(A, 'Three');
    await passWrite();
    expect(await store.readTodos(A)).toHaveLength(3);
    o.deliver();
    await vi.advanceTimersByTimeAsync(100);
    expect(await store.readTodos(A)).toHaveLength(3);
    expect(store.state.items[A].todos).toHaveLength(3);
  });

  it('starts a list at the end of a note that has none', async () => {
    await boot('Just text', []);
    store.addTodo(A, 'First');
    await passWrite();
    expect(bodyOf()).toBe('Just text\n- [ ] First\n');
  });

  it('keeps to the task lines, past frontmatter and code', async () => {
    const body = '---\ntm-log:\n  - [ ] not one\n---\n\n```\n- [ ] nor this\n```\n';
    await boot(body, []);
    store.addTodo(A, 'First');
    await passWrite();
    expect(bodyOf()).toBe(`${body}- [ ] First\n`);
    expect(await store.readTodos(A)).toEqual([{ t: 'First', done: false }]);
  });

  it('keeps the line endings of the note', async () => {
    await boot('- [ ] One\r\n- [ ] Two\r\nEnd', []);
    store.addTodo(A, 'Three');
    await passWrite();
    expect(bodyOf()).toBe('- [ ] One\r\n- [ ] Two\r\n- [ ] Three\r\nEnd');
  });

  it('ignores blank text', async () => {
    await boot();
    expect(store.addTodo(A, '   ')).toBe(false);
    expect(events).toHaveLength(0);
    expect(store.undoLabel).toBeNull();
  });
});

describe('undoing', () => {
  it('a tick puts the checkbox back', async () => {
    await boot();
    store.setTodoDone(A, 0, 'One', true);
    await settle();
    expect(store.undoLabel).toMatch(/One/);
    await store.undo();
    expect(openCount()).toBe(1);
    expect(events.at(-1)?.label).toMatch(/^Undid/);
    await settle();
    expect(bodyOf()).toBe(BODY);
    expect(openCount()).toBe(1);
  });

  it('an add takes the line out again', async () => {
    await boot();
    store.addTodo(A, 'Three');
    await settle();
    await store.undo();
    expect(store.state.items[A].todos).toHaveLength(2);
    await settle();
    expect(bodyOf()).toBe(BODY);
  });

  it('works before the first write has gone out', async () => {
    await boot();
    store.addTodo(A, 'Three');
    await store.undo();
    await settle();
    expect(bodyOf()).toBe(BODY);
    expect(store.state.items[A].todos).toHaveLength(2);
  });

  it('follows a renamed note', async () => {
    await boot();
    store.setTodoDone(A, 0, 'One', true);
    await settle();
    o.rename(A, 'Projects/b.md');
    await vi.advanceTimersByTimeAsync(100);
    await store.undo();
    await settle();
    expect(bodyOf('Projects/b.md')).toBe(BODY);
  });

  it('leaves frontmatter edits and to-dos as separate steps', async () => {
    await boot();
    store.apply(setTotal(A, 20));
    store.setTodoDone(A, 0, 'One', true);
    await store.undo();
    expect(openCount()).toBe(1);
    expect(store.state.items[A].left).toBe(20);
    await store.undo();
    expect(store.state.items[A].left).toBe(6);
    await settle();
  });
});

describe('a note changed by hand', () => {
  it('finds a to-do by text when lines moved', async () => {
    await boot();
    o.notes.get(A)!.body = `- [ ] New\n${BODY}`;
    store.setTodoDone(A, 0, 'One', true);
    await passWrite();
    expect(bodyOf()).toBe(`- [ ] New\n${BODY.replace('[ ] One', '[x] One')}`);
  });

  it('leaves the note and drops the edit when the to-do is gone', async () => {
    await boot();
    o.notes.get(A)!.body = 'Nothing here\n';
    store.setTodoDone(A, 0, 'One', true);
    expect(openCount()).toBe(0);
    await passWrite();
    await vi.advanceTimersByTimeAsync(100);
    expect(bodyOf()).toBe('Nothing here\n');
    expect(openCount()).toBe(1);
  });

  it('wins once the cache reports it', async () => {
    await boot();
    store.setTodoDone(A, 0, 'One', true);
    await settle();
    o.change(A, { 'tm-type': 'item', 'tm-left': 6 }, listed, BODY);
    await vi.advanceTimersByTimeAsync(100);
    expect(openCount()).toBe(1);
  });

  it('schedules nothing after dispose when a last write changed nothing', async () => {
    await boot();
    o.notes.get(A)!.body = 'Nothing here\n';
    store.setTodoDone(A, 0, 'One', true);
    store.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failed write drops the edit', async () => {
    await boot();
    o.failNextWrite = true;
    store.setTodoDone(A, 0, 'One', true);
    await passWrite();
    expect(openCount()).toBe(1);
    expect(store.warnings.at(-1)?.msg).toMatch(/Could not save/);
  });
});
