import { iso, workDays } from './calendar';
import { criticalChains } from './critical';
import { kids, leavesOf } from './graph';
import { EPS, schedule } from './schedule';
import type { Analysis, Conflict, ItemResult, KidsMap, State } from './types';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const mmdd = (d: number) => iso(d).slice(5);

/** Plan says today: hours-weighted share of each leaf's plan window elapsed, in working days. */
function plannedPct(st: State, id: string, K: KidsMap): number | null {
  const s = st.settings;
  let planned = 0;
  let total = 0;
  for (const l of leavesOf(st, id, K)) {
    const p = st.plan[l];
    if (!p || !p.hours) continue;
    total += p.hours;
    const span = workDays(p.start, p.end, s) || 1;
    const gone = st.today < p.start ? 0 : clamp(workDays(p.start, Math.min(st.today - 1, p.end), s), 0, span);
    planned += (p.hours * gone) / span;
  }
  return total ? planned / total : null;
}

/** Full picture for the UI: forecast, rollups, plan comparison, conflicts. */
export function analyze(st: State): Analysis {
  const K = kids(st);
  const S = schedule(st);
  const { C, r } = S;
  const s = st.settings;
  const today = st.today;
  const by: Record<string, ItemResult> = {};
  const conflicts: Conflict[] = [];
  const { crit, links } = criticalChains(st, S, K);

  C.T.forEach((t, i) => {
    const it = t.it;
    const f = r.fin[i] >= 0 ? r.fin[i] : null;
    const start = it.actualStart ?? it.pinS ?? (t.ms ? f : r.first[i] >= 0 ? r.first[i] : f);
    const spent = it.spent ?? 0;
    const l = it.left ?? 0;
    const wd = start != null && f != null ? Math.max(1, workDays(Math.max(start, today), f, s)) : 1;
    const passed = f != null && f < today;
    const b: ItemResult = (by[t.id] = {
      start,
      end: f,
      spent,
      left: l,
      burn: l / wd,
      done: t.ext ? passed : t.ms ? !!it.done || passed : l <= EPS,
      kind: it.kind,
      est: it.est ?? 0,
      crit: !!crit[t.id],
      idleBy: r.idleBy[i] >= 0 && r.idleDay[i] >= 0 ? C.T[r.idleBy[i]].id : null,
      rel: S.rel[t.id],
      pct: 0,
      shouldPct: null,
    });

    if (l > EPS && f == null) conflicts.push({ id: t.id, msg: 'Never finishes inside 4 years of capacity' });

    // A milestone's date is its pin, so a dependency finishing later violates it like a start pin.
    const pin = it.kind === 'ms' ? it.pinE : it.pinS;
    if (pin != null && !t.ext && !b.done) {
      for (const q of t.preds) {
        if (r.fin[q] > pin || r.fin[q] < 0 || (C.T[q].ext && r.fin[q] >= pin)) {
          const when = r.fin[q] >= 0 ? mmdd(r.fin[q]) : 'never';
          conflicts.push({ id: t.id, msg: `${t.ms ? 'Pinned' : 'Starts'} ${mmdd(pin)}, but ${C.T[q].it.title} finishes ${when}` });
        }
      }
    }
    if (S.noRoom.has(t.id) || (it.pinE != null && l > EPS && f != null && f > it.pinE))
      conflicts.push({ id: t.id, msg: `Pinned end ${mmdd(it.pinE!)} is out of reach (forecast ${f != null ? mmdd(f) : 'never'})` });
    if (it.pinS != null && it.pinE != null && l > EPS && it.pinE < today)
      conflicts.push({ id: t.id, msg: 'Pinned window has passed with hours left' });
    // Hours left never updated: the clock runs from the start.
    const touched = it.touched ?? it.actualStart;
    if (l > EPS && it.actualStart != null && touched != null && today - touched >= s.staleDays) b.stale = today - touched;
  });

  if (r.over.length) {
    const peak = r.over.reduce((a, b) => (b.by > a.by ? b : a));
    conflicts.push({
      id: null,
      msg: `Overbooked ${r.over.length} day(s): pinned work exceeds capacity by up to ${peak.by.toFixed(1)}h/day (${mmdd(peak.day)})`,
    });
  }

  const roll = (id: string): ItemResult => {
    const it = st.items[id];
    if (!K[id]) return (by[id] ||= { start: null, end: null, spent: 0, left: 0, est: 0, done: false, crit: false, draft: true, pct: 0, shouldPct: null });
    const b: ItemResult = (by[id] = { start: it.actualStart ?? null, end: null, spent: it.spent ?? 0, left: 0, est: 0, done: true, crit: false, pct: 0, shouldPct: null });
    for (const c of K[id]) {
      const x = roll(c);
      b.spent += x.spent;
      b.left += x.left;
      b.est += x.est;
      b.done = b.done && x.done;
      b.crit = b.crit || x.crit;
      if (x.start != null) b.start = b.start == null ? x.start : Math.min(b.start, x.start);
      if (x.end != null) b.end = b.end == null ? x.end : Math.max(b.end, x.end);
    }
    return b;
  };
  (K[''] ?? []).forEach(roll);

  for (const id in by) {
    const b = by[id];
    const it = st.items[id];
    const p = st.plan[id];
    b.pct = b.spent + b.left > 0 ? b.spent / (b.spent + b.left) : b.done ? 1 : 0;
    if (p && b.end != null) b.shift = b.end >= p.end ? workDays(p.end + 1, b.end, s) : -workDays(b.end + 1, p.end, s);
    if (it.deadline != null && b.end != null) b.overDeadline = b.end > it.deadline ? workDays(it.deadline + 1, b.end, s) : 0;
    b.shouldPct = plannedPct(st, id, K);
    const cs = K[id] && p ? K[id].map(c => st.plan[c]).filter(c => c != null) : [];
    if (p && cs.length) {
      const e = Math.max(...cs.map(c => c.end));
      const h = cs.reduce((a, c) => a + c.hours, 0);
      if (e > p.end) b.planGap = workDays(p.end + 1, e, s);
      if (h > p.hours + 0.5) b.planGapH = h - p.hours;
    }
  }
  return { results: by, conflicts, links, weeks: r.weeks, todayH: r.todayH, kids: K, releaseDay: S.rel, over: r.over };
}
