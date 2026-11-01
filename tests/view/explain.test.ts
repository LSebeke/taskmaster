import { describe, expect, it } from 'vitest';
import { analyze, type State } from '../../src/engine';
import { describeChanges } from '../../src/view/changes';
import { countNotInPlan, statusOf, upcomingExternals, why } from '../../src/view/explain';
import { fmtD, h1 } from '../../src/view/format';
import { D, external, state, task } from '../engine/helpers';

const reason = (st: State, id: string) => why(st, analyze(st), id);

describe('why', () => {
  it('free task', () => {
    expect(reason(state({ a: task('a', 6) }, [['a']]), 'a')).toBe('Free to run now.');
  });

  it('waits for a task', () => {
    const st = state({ a: task('a', 9), b: task('b', 6, { deps: ['a'] }) }, [['a', 'b']]);
    expect(reason(st, 'b')).toBe('Waits for a.');
  });

  it('names an external item and its end date', () => {
    const st = state({ x: external('Bench', '2026-11-02', '2026-11-04'), a: task('a', 6, { deps: ['x'] }) }, [['a']]);
    expect(reason(st, 'a')).toBe('Waits for Bench (external, ends 4 Nov).');
  });

  it('counts a dependency held by an ancestor', () => {
    const st = state({ x: external('Bench', '2026-11-02', '2026-11-04'), p: task('p', 0, { deps: ['x'] }), a: task('a', 6, { parent: 'p' }) }, [['a']]);
    expect(reason(st, 'a')).toBe('Waits for Bench (external, ends 4 Nov).');
  });

  it('ignores a dependency on a draft', () => {
    const st = state({ d: task('d', 0, { est: 0 }), a: task('a', 6, { deps: ['d'] }) }, [['a']]);
    expect(reason(st, 'a')).toBe('Free to run now.');
  });

  it('capacity', () => {
    const st = state({ a: task('a', 60), b: task('b', 6) }, [['a'], ['b']]);
    expect(reason(st, 'b')).toBe('Blocked by capacity: a takes the hours first.');
  });

  it('pins', () => {
    const both = state({ a: task('a', 10, { pinS: D('2026-11-02'), pinE: D('2026-11-06') }) }, [['a']]);
    expect(reason(both, 'a')).toBe('Both ends pinned. Constant burn of 2h/day is reserved from capacity.');
    const end = state({ a: task('a', 12, { pinE: D('2026-11-13') }) }, [['a']]);
    expect(reason(end, 'a')).toBe('End pinned. Latest start that still makes it: 12 Nov, given what runs in parallel.');
    const start = state({ a: task('a', 12, { pinS: D('2026-11-05') }) }, [['a']]);
    expect(reason(start, 'a')).toBe('Start pinned. End follows from hours and what runs in parallel.');
  });

  it('done, with or without a recorded date', () => {
    const st = state({ a: task('a', 0, { spent: 6, doneOn: D('2026-10-30') }) }, []);
    expect(reason(st, 'a')).toBe('Finished 30 Oct.');
  });

  it('draft', () => {
    expect(reason(state({ a: task('a', 0, { est: 0 }) }, []), 'a')).toBe('Not scheduled. Give it hours, or add items inside it.');
  });

  it('external', () => {
    expect(reason(state({ x: external('x', '2026-11-02', '2026-11-04') }, []), 'x')).toBe('External: 2 Nov to 4 Nov. No project hours.');
  });

  it('milestones: pin, dependencies, nothing to wait for', () => {
    const ms = (o = {}) => ({ title: 'm', parent: 'p', kind: 'ms' as const, deps: [], ...o });
    const pinned = state({ p: task('p', 0), m: ms({ pinE: D('2026-11-20') }) }, []);
    expect(reason(pinned, 'm')).toBe('Pinned to 20 Nov.');
    const waiting = state({ p: task('p', 0), a: task('a', 6, { parent: 'p' }), m: ms({ deps: ['a'] }) }, [['a']]);
    expect(reason(waiting, 'm')).toBe('Lands when a finishes.');
    const free = state({ p: task('p', 0), d: task('d', 0, { est: 0, parent: 'p' }), m: ms({ deps: ['d'] }) }, []);
    expect(reason(free, 'm')).toBe('Nothing to wait for, so it lands today.');
  });
});

describe('status', () => {
  const planned = (st: State, id: string, end: string) => (st.plan[id] = { start: D('2026-11-02'), end: D(end), hours: 12 });

  it('reports each state with a glyph, not colour alone', () => {
    const draft = state({ a: task('a', 0, { est: 0 }) }, []);
    expect(statusOf(draft, analyze(draft), 'a')).toMatchObject({ tone: 'plain', title: 'Not scheduled yet' });

    const late = state({ a: task('a', 60, { deadline: D('2026-11-04') }) }, [['a']]);
    expect(statusOf(late, analyze(late), 'a')).toMatchObject({ tone: 'crit', title: '▲ Past deadline by 7 working days' });

    const behind = state({ a: task('a', 30) }, [['a']]);
    planned(behind, 'a', '2026-11-03');
    expect(statusOf(behind, analyze(behind), 'a')).toMatchObject({ tone: 'warn', title: '▲ 3 working days behind plan' });

    const fresh = state({ a: task('a', 6) }, [['a']]);
    expect(statusOf(fresh, analyze(fresh), 'a')).toMatchObject({ tone: 'warn', title: '● Not in the plan yet' });

    const fine = state({ a: task('a', 12) }, [['a']]);
    planned(fine, 'a', '2026-11-03');
    expect(statusOf(fine, analyze(fine), 'a')).toMatchObject({ tone: 'good', title: '✓ Inside the plan' });

    const done = state({ a: task('a', 0, { spent: 6, doneOn: D('2026-10-30') }) }, []);
    planned(done, 'a', '2026-10-30');
    expect(statusOf(done, analyze(done), 'a')).toMatchObject({ tone: 'good', title: '✓ Done' });
  });
});

describe('overview lists', () => {
  it('counts unplanned work, leaving drafts and externals out', () => {
    const st = state({ a: task('a', 6), d: task('d', 0, { est: 0 }), x: external('x', '2026-12-01', '2026-12-02') }, [['a']]);
    expect(countNotInPlan(st, analyze(st), null)).toBe(1);
  });

  it('lists upcoming externals in scope, by start', () => {
    const st = state(
      {
        p: task('p', 0),
        a: task('a', 6, { parent: 'p', deps: ['z'] }),
        q: task('q', 6),
        y: external('y', '2026-11-20', '2026-11-21'),
        z: external('z', '2026-12-01', '2026-12-02'),
        old: external('old', '2026-10-01', '2026-10-02'),
      },
      [['a', 'q']],
    );
    const a = analyze(st);
    expect(upcomingExternals(st, a, null)).toEqual(['y', 'z']);
    expect(upcomingExternals(st, a, 'p')).toEqual(['z']);
  });
});

describe('status bar changes', () => {
  it('counts moved tasks, largest first, capped at four', () => {
    const items = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((k, i) => [k, task(k, 6 * (i + 1))]));
    const before = state(items, Object.keys(items).map(k => [k]));
    const after: State = { ...before, items: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { ...v, left: v.left! + 24 }])) };
    const text = describeChanges(after, analyze(before), analyze(after));
    expect(text).toMatch(/^Forecast moved on 5 tasks: /);
    expect(text.endsWith('…')).toBe(true);
  });

  it('says so when nothing moved, and skips parents', () => {
    const st = state({ p: task('p', 0), a: task('a', 6, { parent: 'p' }) }, [['a']]);
    expect(describeChanges(st, analyze(st), analyze(st))).toBe('Notes changed: no forecast change');
  });
});

describe('status bar with an edit', () => {
  it('names the edit, moved or not', () => {
    const before = state({ a: task('a', 12) }, [['a']]);
    const after: State = { ...before, items: { a: { ...before.items.a, left: 60 } } };
    expect(describeChanges(after, analyze(before), analyze(after), 'a: 60h left')).toMatch(/^a: 60h left: forecast moved on 1 task: a \+\d+d$/);
    expect(describeChanges(before, analyze(before), analyze(before), 'Logged 1h')).toBe('Logged 1h: no forecast change');
  });
});

describe('format', () => {
  it('dates and hours', () => {
    expect(fmtD(D('2026-11-02'))).toBe('2 Nov');
    expect(fmtD(null)).toBe('—');
    expect(h1(2.25)).toBe('2.3');
    expect(h1(4)).toBe('4');
  });
});
