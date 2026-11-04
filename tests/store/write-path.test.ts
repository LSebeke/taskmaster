import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayOf as D, type State } from '../../src/engine';
import { setTotal, TaskmasterStore } from '../../src/store';
import { FakeObsidian } from './fake-obsidian';

const WRITE = 300;
const p = (name: string) => `Projects/${name}.md`;
const item = (left = 6, extra = {}) => ({ 'tm-type': 'item', 'tm-left': left, ...extra });

let o: FakeObsidian;
let store: TaskmasterStore;
let events: State[];

const boot = async () => {
  store = new TaskmasterStore(o.app, { today: () => D('2026-11-02'), debounceMs: 100, writeMs: WRITE });
  await store.load();
  await vi.advanceTimersByTimeAsync(0);
  events = [];
  store.subscribe(s => events.push(s));
};
const passWrite = () => vi.advanceTimersByTimeAsync(WRITE);
/** The write, the cache echo and the recompute window. */
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

describe('note writes', () => {
  it('shows an edit at once and writes frontmatter after the debounce', async () => {
    o.add(p('a'), item(6));
    await boot();
    store.apply(setTotal(p('a'), 20));
    expect(store.state.items[p('a')].left).toBe(20);
    expect(events).toHaveLength(1);
    expect(o.writes).toHaveLength(0);
    await passWrite();
    expect(o.frontmatter(p('a'))).toMatchObject({ 'tm-left': 20, 'tm-left-updated': '2026-11-02' });
  });

  it('collects a burst on one file into one write, per file', async () => {
    o.add(p('a'), item(6));
    o.add(p('b'), item(6));
    await boot();
    store.apply(setTotal(p('a'), 7));
    store.apply(setTotal(p('b'), 8));
    store.apply(setTotal(p('a'), 9));
    await passWrite();
    expect(o.writes.map(w => w.path).sort()).toEqual([p('a'), p('b')]);
    expect(o.frontmatter(p('a'))['tm-left']).toBe(9);
  });

  it('does not recalculate when the cache echo of its own write returns', async () => {
    o.add(p('a'), item(6, { 'tm-log': ['2026-10-30 2'] }));
    await boot();
    store.apply(setTotal(p('a'), 20));
    expect(events).toHaveLength(1);
    await settle();
    expect(events).toHaveLength(1);
    expect(store.state.items[p('a')].left).toBe(18);
  });

  it('keeps showing a newer edit when the echo of an older write arrives', async () => {
    o.add(p('a'), item(6));
    await boot();
    store.apply(setTotal(p('a'), 7));
    await passWrite();
    store.apply(setTotal(p('a'), 9));
    o.deliver();
    await vi.advanceTimersByTimeAsync(100);
    expect(store.state.items[p('a')].left).toBe(9);
    await settle();
    expect(store.state.items[p('a')].left).toBe(9);
    expect(events).toHaveLength(2);
  });

  it('survives a stale echo arriving after the next write went out', async () => {
    o.add(p('a'), item(6));
    await boot();
    store.apply(setTotal(p('a'), 7));
    await passWrite();
    store.apply(setTotal(p('a'), 9));
    await passWrite();
    // Cache reports the first write only.
    o.notes.get(p('a'))!.cache = { frontmatter: item(7) };
    o.emitChanged(p('a'));
    await vi.advanceTimersByTimeAsync(100);
    expect(store.state.items[p('a')].left).toBe(9);
    await settle();
    expect(events).toHaveLength(2);
  });

  it('lets a hand edit of the note through once its writes are confirmed', async () => {
    o.add(p('a'), item(6));
    await boot();
    store.apply(setTotal(p('a'), 7));
    await settle();
    o.change(p('a'), item(3));
    await vi.advanceTimersByTimeAsync(100);
    expect(store.state.items[p('a')].left).toBe(3);
  });

  it('does not shadow a later hand edit after a write that changed nothing', async () => {
    o.add(p('a'), item(6, { 'tm-left-updated': '2026-11-02' }));
    await boot();
    store.apply(setTotal(p('a'), 7));
    store.apply(setTotal(p('a'), 6));
    await passWrite();
    o.change(p('a'), item(3));
    await vi.advanceTimersByTimeAsync(100);
    expect(store.state.items[p('a')].left).toBe(3);
  });

  it('falls back to the note and reports it when a write fails', async () => {
    o.add(p('a'), item(6));
    await boot();
    store.apply(setTotal(p('a'), 7));
    o.failNextWrite = true;
    await passWrite();
    expect(store.state.items[p('a')].left).toBe(6);
    expect(store.warnings.at(-1)).toMatchObject({ path: p('a') });
  });

  it('flushes pending writes on dispose', async () => {
    o.add(p('a'), item(6));
    await boot();
    store.apply(setTotal(p('a'), 7));
    store.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(o.frontmatter(p('a'))['tm-left']).toBe(7);
  });

  it('runs body edits through vault.process, debounced per file', async () => {
    o.add(p('a'), item(6), undefined, '- [ ] x\n');
    await boot();
    store.editBody(p('a'), t => t.replace('[ ]', '[x]'));
    store.editBody(p('a'), t => `${t}more\n`);
    expect(o.writes).toHaveLength(0);
    await passWrite();
    expect(o.writes.map(w => w.body)).toEqual(['- [x] x\nmore\n']);
  });

  it('follows a rename while a write is waiting', async () => {
    o.add(p('a'), item(6));
    await boot();
    store.apply(setTotal(p('a'), 7));
    o.rename(p('a'), p('b'));
    await settle();
    expect(o.frontmatter(p('b'))['tm-left']).toBe(7);
    expect(store.state.items[p('b')].left).toBe(7);
  });
});
