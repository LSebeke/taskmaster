/** The schedule as ported from the prototype, frozen. Slow and obvious: the reference for the fast one in src/engine. */
import { isWork, weekHours, weekOf, workDays } from '../../src/engine/calendar';
import { effDeps, isDraft, kids, rootOf } from '../../src/engine/graph';
import type { Day, Item, ScheduleOptions, State, WeekLoad } from '../../src/engine/types';

export const EPS = 1e-6;
/** Spec: stop at 4 years and report anything unfinished. */
const HORIZON = 1461;

export interface CompiledTask {
  id: string;
  it: Item;
  preds: number[];
  tier: number;
  left: number;
  /** No hours: milestones and external items. */
  ms: boolean;
  ext: boolean;
  root: string;
}

export interface Compiled {
  ids: string[];
  ix: Record<string, number>;
  T: CompiledTask[];
  order: number[];
}

export interface Simulation {
  /** Finish day, -1 if never. */
  fin: Int32Array;
  first: Int32Array;
  left: Float64Array;
  idleDay: Int32Array;
  idleBy: Int32Array;
  weeks: WeekLoad;
  todayH: Record<string, number>;
  over: { day: Day; by: number }[];
}

export interface Schedule {
  C: Compiled;
  r: Simulation;
  rel: Record<string, Day>;
  noRoom: Set<string>;
}

function compile(st: State, opt: ScheduleOptions): Compiled {
  const K = kids(st);
  const ex = opt.exclude ?? new Set<string>();
  const scale = opt.scale ?? (() => 1);
  const ids = Object.keys(st.items).filter(i => !K[i] && !ex.has(i) && !isDraft(st, i, K));
  const tierIx: Record<string, number> = {};
  st.tiers.forEach((t, i) => t.forEach(id => (tierIx[id] = i)));
  const lastTier = st.tiers.length;
  const ix: Record<string, number> = {};
  ids.forEach((id, i) => (ix[id] = i));
  const T = ids.map((id): CompiledTask => {
    const it = st.items[id];
    return {
      id,
      it,
      preds: effDeps(st, id, K)
        .filter(p => p !== id && ix[p] !== undefined)
        .map(p => ix[p]),
      tier: tierIx[id] ?? lastTier,
      left: (it.left ?? 0) * scale(id),
      ms: it.kind === 'ms' || it.kind === 'ext',
      ext: it.kind === 'ext',
      root: rootOf(st, id),
    };
  });
  const order = T.map((_, i) => i).sort((a, b) => T[a].tier - T[b].tier);
  return { ids, ix, T, order };
}

/** Fluid daily simulation: hours flow from weekly capacity to released tasks.
 *  Both-pinned tasks take a reserved constant burn first. Then the highest
 *  priority tier takes everything, sharing equally. */
function simulate(st: State, C: Compiled, rel: Record<string, Day>): Simulation {
  const s = st.settings;
  const today = st.today;
  const n = C.T.length;
  const left = new Float64Array(n);
  const fin = new Int32Array(n).fill(-1);
  const first = new Int32Array(n).fill(-1);
  const got = new Float64Array(n);
  const idleDay = new Int32Array(n).fill(-1);
  const idleBy = new Int32Array(n).fill(-1);
  const reserved: { i: number; a: Day; b: Day; burn: number }[] = [];
  const weeks: WeekLoad = {};
  const todayH: Record<string, number> = {};
  const over: { day: Day; by: number }[] = [];
  let open = 0;

  C.T.forEach((t, i) => {
    left[i] = t.left;
    if (t.ms) {
      if (t.it.done) fin[i] = t.it.doneOn ?? today - 1;
      else open++;
      return;
    }
    if (left[i] <= EPS) {
      fin[i] = t.it.doneOn ?? today - 1;
      return;
    }
    open++;
    if (t.it.pinS != null && t.it.pinE != null) {
      const a = Math.max(t.it.pinS, today);
      const wd = workDays(a, t.it.pinE, s);
      reserved.push({ i, a, b: t.it.pinE, burn: wd ? left[i] / wd : left[i] });
    }
  });
  const isReserved = new Uint8Array(n);
  reserved.forEach(p => (isReserved[p.i] = 1));

  /** An external item blocks through its last day. Work resumes the day after. */
  const passed = (p: number, d: Day) => fin[p] >= 0 && fin[p] <= (C.T[p].ext ? d - 1 : d);

  const ready = (i: number, d: Day) => {
    const t = C.T[i];
    if (fin[i] >= 0 || isReserved[i]) return false;
    if (t.it.pinS != null) return t.it.pinS <= d;
    if (rel[t.id] != null && rel[t.id] > d) return false;
    return t.preds.every(p => passed(p, d));
  };

  const give = (i: number, h: number, d: Day) => {
    left[i] -= h;
    got[i] += h;
    if (first[i] < 0 && h > EPS) first[i] = d;
    const t = C.T[i];
    const wk = (weeks[weekOf(d)] ||= {});
    wk[t.root] = (wk[t.root] || 0) + h;
    if (d === today) todayH[t.id] = (todayH[t.id] || 0) + h;
    if (left[i] <= EPS) {
      fin[i] = d;
      open--;
    }
  };

  /** Spec: an unpinned milestone's date is when its dependencies finish, even if that is past. */
  const milestoneDate = (m: CompiledTask, d: Day): Day => {
    if (m.it.pinE != null) return m.it.pinE;
    if (d !== today || !m.preds.length) return d;
    const last = Math.max(...m.preds.map(p => fin[p]));
    return last < today ? last : d;
  };

  /** Repeats so that a milestone waiting on another settles the same day. */
  const settleMilestones = (d: Day) => {
    let any = false;
    for (let changed = true; changed; ) {
      changed = false;
      for (let i = 0; i < n; i++) {
        const m = C.T[i];
        if (!m.ms || fin[i] >= 0) continue;
        if (m.it.pinE != null ? m.it.pinE <= d : m.preds.every(p => passed(p, d))) {
          fin[i] = milestoneDate(m, d);
          open--;
          changed = any = true;
        }
      }
    }
    return any;
  };

  const end = today + HORIZON;
  for (let d = today; d <= end && open > 0; d++) {
    got.fill(0);
    if (!isWork(d, s)) {
      for (let i = 0; i < n; i++) {
        const m = C.T[i];
        if (m.ms && fin[i] < 0 && m.it.pinE != null && m.it.pinE <= d) {
          fin[i] = m.it.pinE;
          open--;
        }
      }
      continue;
    }

    let cap = weekHours(weekOf(d), s) / 5;
    for (const p of reserved) {
      if (fin[p.i] < 0 && d >= p.a) {
        const h = d >= p.b ? left[p.i] : Math.min(p.burn, left[p.i]);
        give(p.i, h, d);
        cap -= h;
      }
    }
    if (cap < -EPS) over.push({ day: d, by: -cap });
    cap = Math.max(cap, 0);

    let top = -1;
    for (let guard = 0; guard < 4 * n + 8; guard++) {
      const settled = settleMilestones(d);
      if (cap <= EPS) break;
      let tier = -1;
      let active: number[] = [];
      for (const i of C.order) {
        if (C.T[i].ms) continue;
        if (tier >= 0 && C.T[i].tier !== tier) break;
        if (ready(i, d)) {
          tier = C.T[i].tier;
          active.push(i);
        }
      }
      if (!active.length) {
        if (settled) continue;
        break;
      }
      if (top < 0) top = active[0];
      let c = cap;
      while (active.length && c > EPS) {
        const share = c / active.length;
        const small = active.filter(i => left[i] <= share + EPS);
        if (small.length) {
          for (const i of small) {
            c -= left[i];
            give(i, left[i], d);
          }
          active = active.filter(i => fin[i] < 0);
        } else {
          for (const i of active) give(i, share, d);
          c = 0;
        }
      }
      cap = Math.max(c, 0);
    }

    for (let i = 0; i < n; i++) {
      if (ready(i, d) && got[i] <= EPS) {
        idleDay[i] = d;
        idleBy[i] = top >= 0 ? top : (reserved.find(p => got[p.i] > EPS)?.i ?? -1);
      }
    }
  }
  return { fin, first, left, idleDay, idleBy, weeks, todayH, over };
}

/** Compiles once, then binary-searches each end-pinned task's latest release day. */
export function schedule(st: State, opt: ScheduleOptions = {}): Schedule {
  const C = compile(st, opt);
  const rel: Record<string, Day> = {};
  const noRoom = new Set<string>();
  const endPinned = C.order
    .map(i => C.T[i])
    .filter(t => !t.ms && t.left > EPS && t.it.pinE != null && t.it.pinS == null);
  for (const t of endPinned) {
    const pin = t.it.pinE!;
    let lo = st.today;
    let hi = pin;
    let best: Day | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      rel[t.id] = mid;
      const f = simulate(st, C, rel).fin[C.ix[t.id]];
      if (f >= 0 && f <= pin) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    rel[t.id] = best ?? st.today;
    if (best == null) noRoom.add(t.id);
  }
  return { C, r: simulate(st, C, rel), rel, noRoom };
}
