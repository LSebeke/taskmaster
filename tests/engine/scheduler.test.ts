import { describe, expect, it } from 'vitest';
import { analyze, dayOf, isWork, iso, weekOf, weekStart, workDays } from '../../src/engine';
import { D, day, state, task } from './helpers';

describe('calendar', () => {
  const s = { weekly: 30, staleDays: 7, holidays: [D('2026-11-04')] };

  it('round-trips ISO dates', () => {
    expect(iso(dayOf('2026-11-02'))).toBe('2026-11-02');
  });

  it('counts Mon to Fri minus holidays', () => {
    expect(isWork(D('2026-11-02'), s)).toBe(true); // Mon
    expect(isWork(D('2026-11-04'), s)).toBe(false); // holiday
    expect(isWork(D('2026-11-07'), s)).toBe(false); // Sat
    expect(workDays(D('2026-11-02'), D('2026-11-08'), s)).toBe(4);
  });

  it('puts a whole Mon-Sun week in one bucket', () => {
    expect(weekOf(D('2026-11-02'))).toBe(weekOf(D('2026-11-08')));
    expect(weekOf(D('2026-11-09'))).toBe(weekOf(D('2026-11-08')) + 1);
    expect(iso(weekStart(weekOf(D('2026-11-05'))))).toBe('2026-11-02');
  });
});

describe('acceptance: tiers and burn', () => {
  it('a 12h, b 12h tied: both end Thu 5 Nov, 3 h/day each', () => {
    const { by } = analyze(state({ a: task('a', 12), b: task('b', 12) }, [['a', 'b']]));
    expect(day(by.a.end)).toBe('2026-11-05');
    expect(day(by.b.end)).toBe('2026-11-05');
    expect(by.a.burn).toBe(3);
    expect(by.b.burn).toBe(3);
  });

  it('a 12h ranked above b 12h: a ends Tue 3 Nov, b runs Wed 4 to Thu 5 Nov', () => {
    const { by } = analyze(state({ a: task('a', 12), b: task('b', 12) }, [['a'], ['b']]));
    expect(day(by.a.end)).toBe('2026-11-03');
    expect(day(by.b.start)).toBe('2026-11-04');
    expect(day(by.b.end)).toBe('2026-11-05');
  });

  it('a 3h, then b 3h depending on a: both end 2 Nov', () => {
    const { by } = analyze(state({ a: task('a', 3), b: task('b', 3, { deps: ['a'] }) }, [['a', 'b']]));
    expect(day(by.a.end)).toBe('2026-11-02');
    expect(day(by.b.end)).toBe('2026-11-02');
  });
});

describe('acceptance: pins', () => {
  it('a 12h, start pinned Thu 5 Nov: 5 Nov to Fri 6 Nov', () => {
    const { by } = analyze(state({ a: task('a', 12, { pinS: D('2026-11-05') }) }, [['a']]));
    expect(day(by.a.start)).toBe('2026-11-05');
    expect(day(by.a.end)).toBe('2026-11-06');
  });

  it('a 12h, end pinned Fri 13 Nov: starts Thu 12 Nov', () => {
    const { by } = analyze(state({ a: task('a', 12, { pinE: D('2026-11-13') }) }, [['a']]));
    expect(day(by.a.start)).toBe('2026-11-12');
    expect(day(by.a.end)).toBe('2026-11-13');
  });

  it('a 12h end pinned 13 Nov, tied with b 60h: a starts Tue 10 Nov', () => {
    const st = state({ a: task('a', 12, { pinE: D('2026-11-13') }), b: task('b', 60) }, [['a', 'b']]);
    expect(day(analyze(st).by.a.start)).toBe('2026-11-10');
  });

  it('a 10h pinned 2 to 6 Nov, b 20h: a reserves 2 h/day, b gets 4 h/day and ends 6 Nov', () => {
    const st = state(
      { a: task('a', 10, { pinS: D('2026-11-02'), pinE: D('2026-11-06') }), b: task('b', 20) },
      [['a', 'b']],
    );
    const { by } = analyze(st);
    expect(by.a.burn).toBe(2);
    expect(by.b.burn).toBe(4);
    expect(day(by.a.end)).toBe('2026-11-06');
    expect(day(by.b.end)).toBe('2026-11-06');
  });

  it('a 16h pinned 2 to 2 Nov: overbooked conflict', () => {
    const st = state({ a: task('a', 16, { pinS: D('2026-11-02'), pinE: D('2026-11-02') }) }, [['a']]);
    expect(analyze(st).conflicts.some(c => /Overbooked/.test(c.msg))).toBe(true);
  });

  it('a 60h ranked above b 6h, b depends on a, b start pinned 3 Nov: b stays, conflict on b', () => {
    const st = state(
      { a: task('a', 60), b: task('b', 6, { deps: ['a'], pinS: D('2026-11-03') }) },
      [['a'], ['b']],
    );
    const r = analyze(st);
    expect(day(r.by.b.start)).toBe('2026-11-03');
    expect(r.conflicts.some(c => c.id === 'b')).toBe(true);
  });

  it('a 60h, end pinned 3 Nov: conflict, pin out of reach, showing forecast end', () => {
    const r = analyze(state({ a: task('a', 60, { pinE: D('2026-11-03') }) }, [['a']]));
    const c = r.conflicts.find(x => x.id === 'a');
    expect(c?.msg).toMatch(/out of reach/);
    expect(c?.msg).toContain('11-13'); // 10 working days at 6h
    expect(day(r.by.a.end)).toBe('2026-11-13');
  });

  it('pinned window in the past with hours left: conflict, hours land on the first available day', () => {
    const st = state({ a: task('a', 4, { pinS: D('2026-10-05'), pinE: D('2026-10-06') }) }, [['a']]);
    const r = analyze(st);
    expect(r.conflicts.some(c => c.id === 'a' && /passed/.test(c.msg))).toBe(true);
    expect(day(r.by.a.end)).toBe('2026-11-02');
  });

  it('start pin shows actual start first, then the pin', () => {
    const st = state(
      { a: task('a', 12, { actualStart: D('2026-10-30'), pinS: D('2026-11-05') }) },
      [['a']],
    );
    expect(day(analyze(st).by.a.start)).toBe('2026-10-30');
  });
});

describe('capacity', () => {
  it('skips holidays', () => {
    const st = state({ a: task('a', 12) }, [['a']]);
    st.settings.holidays = [D('2026-11-02')];
    expect(day(analyze(st).by.a.end)).toBe('2026-11-04');
  });

  it('reports work that never finishes inside 4 years', () => {
    const r = analyze(state({ a: task('a', 1e6) }, [['a']]));
    expect(r.by.a.end).toBeNull();
    expect(r.conflicts.some(c => c.id === 'a' && /4 years/.test(c.msg))).toBe(true);
  });
});

describe('acceptance: critical chain', () => {
  it('a 12h ranked above b 12h: chain a to b, capacity link', () => {
    const r = analyze(state({ a: task('a', 12), b: task('b', 12) }, [['a'], ['b']]));
    expect(r.links.map(l => [l.a, l.b, l.kind])).toEqual([['a', 'b', 'cap']]);
    expect(r.by.b.crit).toBe(true);
  });

  it('follows the latest-finishing predecessor when not idle', () => {
    const items = { a: task('a', 6), b: task('b', 28), c: task('c', 6, { deps: ['a', 'b'] }) };
    const r = analyze(state(items, [['a', 'b', 'c']]));
    expect(r.links.map(l => [l.a, l.b, l.kind])).toEqual([['b', 'c', 'dep']]);
  });

  it('stops at work finished before today', () => {
    const items = {
      a: task('a', 0, { spent: 5, doneOn: D('2026-10-30') }),
      b: task('b', 12, { deps: ['a'] }),
    };
    const r = analyze(state(items, [['b']]));
    expect(r.links).toEqual([]);
    expect(r.by.a.crit).toBe(false);
  });
});

describe('acceptance: order and empty levels do not change the forecast', () => {
  const items = () => ({ a: task('a', 12), b: task('b', 30), c: task('c', 6) });

  it('level order [a,b,c] vs [c,b,a]', () => {
    const x = analyze(state(items(), [['a', 'b', 'c']]));
    const y = analyze(state(items(), [['c', 'b', 'a']]));
    for (const k of ['a', 'b', 'c']) expect(x.by[k].end).toBe(y.by[k].end);
  });

  it('empty levels added between [a] and [b]', () => {
    const m = () => ({ a: task('a', 12), b: task('b', 12) });
    const x = analyze(state(m(), [[], ['a'], [], ['b']]));
    const y = analyze(state(m(), [['a'], ['b']]));
    expect(x.by.b.end).toBe(y.by.b.end);
    expect(x.by.a.end).toBe(y.by.a.end);
  });
});
