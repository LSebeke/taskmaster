import { isWork, weekHours, weekOf, workDays } from './calendar';
import { effDeps, isDraft, kids, rootOf } from './graph';
import type { Day, Item, ScheduleOptions, State, WeekLoad } from './types';

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

/** No start pin and no release day. */
const NO_GATE = -2147483648;

interface Reservation {
  i: number;
  a: Day;
  b: Day;
  burn: number;
}

/** A run stopped at the start of a day. */
interface Checkpoint {
  day: Day;
  left: Float64Array;
  fin: Int32Array;
  need: Int32Array;
  run: Int32Array;
  gated: Int32Array;
  runLen: number;
  gatedLen: number;
  open: number;
  later: number[];
  due: number[];
  nextDated: number;
}

/**
 * Fluid daily simulation: hours flow from weekly capacity to released tasks. Both-pinned tasks take a
 * reserved constant burn first. Then the highest priority tier takes everything, sharing equally.
 *
 * End pins run this hundreds of times per recalculation, so no step scans every task. A task is
 * released once, by the event that frees it, and `run` holds released tasks in priority order.
 */
class Simulator {
  private readonly n: number;
  private readonly today: Day;
  private readonly end: Day;
  private readonly T: CompiledTask[];
  private readonly tier: Int32Array;
  private readonly ext: Uint8Array;
  /** Position in `C.order`. */
  private readonly rank: Int32Array;
  /** The tasks each task's passing can release. */
  private readonly next: number[][];
  private readonly reserved: Reservation[] = [];
  private readonly isReserved: Uint8Array;
  /** Capacity a day, by days since today. */
  private readonly hours: Float64Array;
  private readonly isWork: Uint8Array;
  /** Tasks with hours to place, in priority order. */
  private readonly pool: number[] = [];

  /** First day a task may start: its start pin or release day. */
  private readonly gate: Int32Array;

  // What every run starts from.
  private readonly left0: Float64Array;
  private readonly fin0: Int32Array;
  private readonly need0: Int32Array;
  private readonly open0: number;
  private readonly later0: number[] = [];
  private readonly due0: number[] = [];
  /** Open milestones. */
  private readonly ms: number[] = [];
  /** Those with an end date, soonest first. Dependencies do not move them. */
  private readonly dated: number[];

  private left: Float64Array;
  private fin: Int32Array;
  /** Dependencies not yet passed. */
  private need: Int32Array;
  private open = 0;
  /** Finished items that pass only on a coming day. */
  private later: number[] = [];
  /** Released tasks. Finished ones leave at the next look. */
  private run: Int32Array;
  private runLen = 0;
  /** The tasks sharing today's hours, and their hours left. `left` catches up only when asked. */
  private active: Int32Array;
  private activeLeft: Float64Array;
  private activeLen = 0;
  /** At most the fewest hours left in `active`. Saves scanning for a task that needs less than a share. */
  private low = -Infinity;
  /** Released at or above the active level, and not yet in `active`. */
  private joined: number[] = [];
  /** Unpinned milestones with all dependencies passed. */
  private due: number[] = [];
  /** Dated milestones and external items not yet reached: an index into `dated`. */
  private nextDated = 0;
  /** Tasks whose gate has not opened. */
  private gated: Int32Array;
  private gatedLen = 0;
  /** Only the final run keeps a record. A probe needs just finish days. */
  private rec: Simulation | null = null;
  private got: Float64Array | null = null;

  constructor(st: State, C: Compiled) {
    const n = C.T.length;
    const s = st.settings;
    this.n = n;
    this.T = C.T;
    this.today = st.today;
    this.end = st.today + HORIZON;
    this.tier = Int32Array.from(C.T, t => t.tier);
    this.ext = Uint8Array.from(C.T, t => (t.ext ? 1 : 0));
    this.rank = new Int32Array(n);
    C.order.forEach((i, k) => (this.rank[i] = k));
    this.next = C.T.map(() => []);
    this.isReserved = new Uint8Array(n);
    this.gate = new Int32Array(n).fill(NO_GATE);
    this.hours = new Float64Array(HORIZON + 1);
    this.isWork = new Uint8Array(HORIZON + 1);
    for (let k = 0; k <= HORIZON; k++) {
      const d = st.today + k;
      this.isWork[k] = isWork(d, s) ? 1 : 0;
      this.hours[k] = weekHours(weekOf(d), s) / 5;
    }

    this.left0 = new Float64Array(n);
    this.fin0 = new Int32Array(n).fill(-1);
    this.need0 = new Int32Array(n);
    let open = 0;
    C.T.forEach((t, i) => {
      this.left0[i] = t.left;
      if (t.ms) {
        if (t.it.done) this.fin0[i] = t.it.doneOn ?? st.today - 1;
        else {
          open++;
          this.ms.push(i);
        }
        return;
      }
      if (t.left <= EPS) {
        this.fin0[i] = t.it.doneOn ?? st.today - 1;
        return;
      }
      open++;
      if (t.it.pinS != null && t.it.pinE != null) {
        const a = Math.max(t.it.pinS, st.today);
        const wd = workDays(a, t.it.pinE, s);
        this.reserved.push({ i, a, b: t.it.pinE, burn: wd ? t.left / wd : t.left });
        this.isReserved[i] = 1;
      }
    });
    this.open0 = open;

    this.dated = this.ms.filter(i => C.T[i].it.pinE != null).sort((a, b) => C.T[a].it.pinE! - C.T[b].it.pinE!);
    const seen = new Uint8Array(n);
    const count = (i: number) => {
      for (const p of C.T[i].preds) {
        if (this.passDay(p, this.fin0) <= st.today) continue;
        this.need0[i]++;
        this.next[p].push(i);
        if (this.fin0[p] >= 0 && !seen[p]) {
          seen[p] = 1;
          this.later0.push(p);
        }
      }
    };
    for (const i of C.order) {
      const t = C.T[i];
      if (t.ms || this.fin0[i] >= 0 || this.isReserved[i]) continue;
      this.pool.push(i);
      if (t.it.pinS != null) this.gate[i] = t.it.pinS;
      else count(i);
    }
    for (const i of this.ms) {
      if (C.T[i].it.pinE != null) continue;
      count(i);
      if (!this.need0[i]) this.due0.push(i);
    }

    this.left = new Float64Array(n);
    this.fin = new Int32Array(n);
    this.need = new Int32Array(n);
    this.run = new Int32Array(n);
    this.active = new Int32Array(n);
    this.activeLeft = new Float64Array(n);
    this.gated = new Int32Array(n);
  }

  /** An external item blocks through its last day. Work resumes the day after. */
  private passDay(p: number, fin: Int32Array): Day {
    return fin[p] < 0 ? Infinity : fin[p] + this.ext[p];
  }

  private passed(p: number, d: Day) {
    return this.passDay(p, this.fin) <= d;
  }

  private reset() {
    this.left.set(this.left0);
    this.fin.set(this.fin0);
    this.need.set(this.need0);
    this.open = this.open0;
    this.later = this.later0.slice();
    this.due = this.due0.slice();
    this.nextDated = 0;
    this.runLen = 0;
    this.gatedLen = 0;
    this.activeLen = 0;
    this.joined.length = 0;
    for (const i of this.pool) {
      if (this.gate[i] > this.today) this.gated[this.gatedLen++] = i;
      else if (this.need[i] === 0) this.run[this.runLen++] = i;
    }
  }

  /** Where `i` goes among `len` tasks in priority order. */
  private place(tasks: Int32Array, len: number, i: number): number {
    const { rank } = this;
    let lo = 0;
    let hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rank[tasks[mid]] < rank[i]) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private release(i: number) {
    const { run } = this;
    const at = this.place(run, this.runLen, i);
    run.copyWithin(at + 1, at, this.runLen);
    run[at] = i;
    this.runLen++;
    if (this.activeLen && this.tier[i] <= this.tier[this.active[0]]) this.joined.push(i);
  }

  private pass(p: number, d: Day) {
    for (const i of this.next[p]) {
      if (--this.need[i]) continue;
      if (this.T[i].ms) this.due.push(i);
      else if (this.gate[i] <= d) this.release(i);
    }
  }

  private finish(i: number, on: Day, d: Day) {
    this.fin[i] = on;
    this.open--;
    if (this.passDay(i, this.fin) <= d) this.pass(i, d);
    else this.later.push(i);
  }

  /** What a new day frees: external items that ended and gates that opened. */
  private dawn(d: Day) {
    const { later, gated, gate } = this;
    // Gates first: a task freed by both must not be released twice.
    let w = 0;
    for (let k = 0; k < this.gatedLen; k++) {
      const i = gated[k];
      if (gate[i] > d) gated[w++] = i;
      else if (this.need[i] === 0) this.release(i);
    }
    this.gatedLen = w;
    if (later.length) {
      const due = later.filter(p => this.passDay(p, this.fin) <= d);
      if (due.length) {
        this.later = later.filter(p => this.passDay(p, this.fin) > d);
        for (const p of due) this.pass(p, d);
      }
    }
  }

  /** For the record: `h` hours went to `i` on `d`. */
  private note(rec: Simulation, i: number, h: number, d: Day) {
    this.got![i] += h;
    if (rec.first[i] < 0 && h > EPS) rec.first[i] = d;
    const t = this.T[i];
    const wk = (rec.weeks[weekOf(d)] ||= {});
    wk[t.root] = (wk[t.root] || 0) + h;
    if (d === this.today) rec.todayH[t.id] = (rec.todayH[t.id] || 0) + h;
  }

  /** Spec: an unpinned milestone's date is when its dependencies finish, even if that is past. */
  private milestoneDate(m: CompiledTask, d: Day): Day {
    if (m.it.pinE != null) return m.it.pinE;
    if (d !== this.today || !m.preds.length) return d;
    const last = Math.max(...m.preds.map(p => this.fin[p]));
    return last < this.today ? last : d;
  }

  private settleDated(d: Day) {
    const { dated, T } = this;
    let any = false;
    for (; this.nextDated < dated.length; this.nextDated++) {
      const i = dated[this.nextDated];
      const pin = T[i].it.pinE!;
      if (pin > d) break;
      this.finish(i, pin, d);
      any = true;
    }
    return any;
  }

  /** Drains: a milestone waiting on another settles the same day. */
  private settleMilestones(d: Day) {
    let any = this.settleDated(d);
    while (this.due.length) {
      const i = this.due.pop()!;
      this.finish(i, this.milestoneDate(this.T[i], d), d);
      any = true;
    }
    return any;
  }

  private flushActive() {
    const { left, active, activeLeft } = this;
    for (let k = 0; k < this.activeLen; k++) left[active[k]] = activeLeft[k];
  }

  /** Brings `active` up to date: the unfinished tasks of the first level that has any. */
  private topLevel(): number {
    const { run, fin, tier, active, activeLeft, left, joined } = this;
    if (this.activeLen) {
      if (!joined.length) return this.activeLen;
      const top = tier[active[0]];
      if (joined.every(i => tier[i] === top)) {
        for (const i of joined) {
          const at = this.place(active, this.activeLen, i);
          active.copyWithin(at + 1, at, this.activeLen);
          activeLeft.copyWithin(at + 1, at, this.activeLen);
          active[at] = i;
          activeLeft[at] = left[i];
          this.activeLen++;
          this.low = Math.min(this.low, left[i]);
        }
        joined.length = 0;
        return this.activeLen;
      }
    }
    joined.length = 0;
    this.low = -Infinity;
    this.flushActive();
    let level = -1;
    let m = 0;
    let w = 0;
    let k = 0;
    for (; k < this.runLen; k++) {
      const i = run[k];
      if (fin[i] >= 0) continue;
      if (level >= 0 && tier[i] !== level) break;
      level = tier[i];
      activeLeft[m] = left[i];
      active[m++] = i;
      run[w++] = i;
    }
    if (w < k) {
      run.copyWithin(w, k, this.runLen);
      this.runLen -= k - w;
    }
    return (this.activeLen = m);
  }

  /** Divides hours equally. A task needing less than its share frees the rest for the others. Returns what is left. */
  private share(hours: number, d: Day): number {
    const { active, activeLeft, left, rec } = this;
    let c = hours;
    let m = this.activeLen;
    while (m && c > EPS) {
      const each = c / m;
      const small = each + EPS;
      let any = false;
      if (this.low <= small) {
        for (let k = 0; k < m; k++) {
          if (activeLeft[k] <= small) {
            any = true;
            break;
          }
        }
      }
      if (any) {
        this.low = -Infinity;
        let w = 0;
        for (let k = 0; k < m; k++) {
          const i = active[k];
          const l = activeLeft[k];
          if (l <= small) {
            c -= l;
            left[i] = 0;
            if (rec) this.note(rec, i, l, d);
            this.finish(i, d, d);
          } else {
            active[w] = i;
            activeLeft[w++] = l;
          }
        }
        m = w;
      } else {
        let low = Infinity;
        for (let k = 0; k < m; k++) {
          const l = activeLeft[k] - each;
          activeLeft[k] = l;
          if (l < low) low = l;
        }
        this.low = low;
        if (rec) for (let k = 0; k < m; k++) this.note(rec, active[k], each, d);
        if (low <= EPS) {
          // Rounding only: more than a share left, yet nothing after it.
          let w = 0;
          for (let k = 0; k < m; k++) {
            const i = active[k];
            const l = activeLeft[k];
            if (l <= EPS) {
              left[i] = l;
              this.finish(i, d, d);
            } else {
              active[w] = i;
              activeLeft[w++] = l;
            }
          }
          m = w;
        }
        c = 0;
      }
    }
    this.activeLen = m;
    return Math.max(c, 0);
  }

  /** For the record: who sat ready with nothing to do today, and because of whom. */
  private noteIdle(d: Day, top: number) {
    const { rec, got, run, fin, T } = this;
    if (!rec || !got) return;
    const by = top >= 0 ? top : (this.reserved.find(p => got[p.i] > EPS)?.i ?? -1);
    const idle = (i: number) => {
      rec.idleDay[i] = d;
      rec.idleBy[i] = by;
    };
    for (let k = 0; k < this.runLen; k++) {
      const i = run[k];
      if (fin[i] < 0 && got[i] <= EPS) idle(i);
    }
    for (const i of this.ms) {
      if (fin[i] >= 0) continue;
      const { it, preds } = T[i];
      if (it.pinS != null ? it.pinS <= d : preds.every(p => this.passed(p, d))) idle(i);
    }
  }

  private day(d: Day) {
    const { left, fin, rec } = this;
    const k = d - this.today;
    if (!this.isWork[k]) {
      this.settleDated(d);
      return;
    }
    this.dawn(d);
    this.got?.fill(0);

    let cap = this.hours[k];
    for (const p of this.reserved) {
      if (fin[p.i] < 0 && d >= p.a) {
        const h = d >= p.b ? left[p.i] : Math.min(p.burn, left[p.i]);
        left[p.i] -= h;
        if (rec) this.note(rec, p.i, h, d);
        if (left[p.i] <= EPS) this.finish(p.i, d, d);
        cap -= h;
      }
    }
    if (rec && cap < -EPS) rec.over.push({ day: d, by: -cap });
    cap = Math.max(cap, 0);

    let top = -1;
    for (;;) {
      const settled = this.settleMilestones(d);
      if (cap <= EPS) break;
      if (!this.topLevel()) {
        if (settled) continue;
        break;
      }
      if (top < 0) top = this.active[0];
      cap = this.share(cap, d);
    }
    this.noteIdle(d, top);
  }

  private save(day: Day, c: Checkpoint | null): Checkpoint {
    this.flushActive();
    const { left, fin, need, run, gated } = this;
    const to = c ?? { day, left: left.slice(), fin: fin.slice(), need: need.slice(), run: run.slice(), gated: gated.slice(), runLen: 0, gatedLen: 0, open: 0, later: [], due: [], nextDated: 0 };
    if (c) {
      c.left.set(left);
      c.fin.set(fin);
      c.need.set(need);
      c.run.set(run);
      c.gated.set(gated);
    }
    to.day = day;
    to.runLen = this.runLen;
    to.gatedLen = this.gatedLen;
    to.open = this.open;
    to.later = this.later.slice();
    to.due = this.due.slice();
    to.nextDated = this.nextDated;
    return to;
  }

  private load(c: Checkpoint) {
    this.left.set(c.left);
    this.fin.set(c.fin);
    this.need.set(c.need);
    this.run.set(c.run);
    this.gated.set(c.gated);
    this.runLen = c.runLen;
    this.gatedLen = c.gatedLen;
    this.open = c.open;
    this.later = c.later.slice();
    this.due = c.due.slice();
    this.nextDated = c.nextDated;
    this.activeLen = 0;
    this.joined.length = 0;
  }

  /**
   * The latest day `i` can start and still finish by `pin`, or null. A binary search over runs.
   *
   * Until `i` starts, a run does not depend on when it will, so every probe after a success resumes
   * from the day that one started. Probes also stop as soon as the answer is known.
   */
  latestStart(i: number, pin: Day): Day | null {
    const last = Math.min(pin, this.end);
    const { fin } = this;
    let from: Checkpoint | null = null;
    let spare: Checkpoint | null = null;
    let lo = this.today;
    let hi = pin;
    let best: Day | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      this.gate[i] = mid;
      if (from) this.load(from);
      else this.reset();
      let at: Checkpoint | null = null;
      for (let d = from ? from.day : this.today; d <= last && this.open > 0 && fin[i] < 0; d++) {
        // Only while `i` still waits at its gate does this state hold for any later start.
        if (d === mid && mid > this.today) at = this.save(d, spare);
        this.day(d);
      }
      if (fin[i] >= 0 && fin[i] <= pin) {
        best = mid;
        lo = mid + 1;
        if (at) {
          spare = from;
          from = at;
        }
      } else {
        hi = mid - 1;
        if (at) spare = at;
      }
    }
    this.gate[i] = best ?? this.today;
    return best;
  }

  /** The whole schedule, on the record. */
  result(): Simulation {
    const { n } = this;
    const rec: Simulation = {
      fin: this.fin,
      first: new Int32Array(n).fill(-1),
      left: this.left,
      idleDay: new Int32Array(n).fill(-1),
      idleBy: new Int32Array(n).fill(-1),
      weeks: {},
      todayH: {},
      over: [],
    };
    this.rec = rec;
    this.got = new Float64Array(n);
    this.reset();
    for (let d = this.today; d <= this.end && this.open > 0; d++) this.day(d);
    this.flushActive();
    return rec;
  }
}

/** Compiles once, then binary-searches each end-pinned task's latest release day. */
export function schedule(st: State, opt: ScheduleOptions = {}): Schedule {
  const C = compile(st, opt);
  const sim = new Simulator(st, C);
  const rel: Record<string, Day> = {};
  const noRoom = new Set<string>();
  const endPinned = C.order
    .map(i => C.T[i])
    .filter(t => !t.ms && t.left > EPS && t.it.pinE != null && t.it.pinS == null);
  for (const t of endPinned) {
    const best = sim.latestStart(C.ix[t.id], t.it.pinE!);
    rel[t.id] = best ?? st.today;
    if (best == null) noRoom.add(t.id);
  }
  return { C, r: sim.result(), rel, noRoom };
}
