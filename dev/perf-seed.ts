import { analyze, dayOf, snapshot, type Item, type State } from '../src/engine';

export interface PerfOptions {
  /** How many tasks, milestones and external items. Parents come on top, unless `items` says otherwise. */
  tasks?: number;
  /** Stops at this many notes of any kind. */
  items?: number;
  /** Share of open tasks with only an end pin. Each one costs a binary search of simulations. */
  endPinned?: number;
  weekly?: number;
  /** Priority levels. By default one for each package of ten tasks. */
  levels?: number;
}

/** A hash, not Math.random: every run measures the same schedule. */
const roll = (n: number, mod: number) => (Math.imul(n + 1, 2654435761) >>> 12) % mod;

const EVERY_PACKAGE = 10;
const EVERY_PROJECT = 100;
const DAY_SPREAD = 7;

/**
 * The prototype's stress data, grown into what a real vault holds: done work, logs, a plan, scopes,
 * milestones, pinned windows, external items, holidays and a share of end pins spread over the schedule.
 */
export function perfSeed({ tasks = Infinity, items = Infinity, endPinned = 0, weekly = 40, levels }: PerfOptions): State {
  const today = dayOf('2026-11-02');
  const holidays = ['2026-12-24', '2026-12-25', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-04-02', '2027-04-05', '2027-05-14', '2027-12-24'].map(dayOf);
  const st: State = { items: {}, plan: {}, today, settings: { weekly, staleDays: 7, holidays }, tiers: [] };
  const all = st.items;
  const base = { scope: 'must' as const, deps: [] as string[], todos: [], notes: [] };
  const add = (id: string, it: Item) => (all[id] = it);
  const count = () => Object.keys(all).length;

  let project = '';
  let group = '';
  let tier: string[] = [];
  let prev: string | null = null;
  let leaves = 0;
  const keyed: string[] = [];
  while (leaves < tasks && count() < items) {
    const n = leaves;
    if (n % EVERY_PROJECT === 0) {
      project = `p${n / EVERY_PROJECT}`;
      add(project, { ...base, title: `Project ${n / EVERY_PROJECT}`, parent: null, kind: 'item', deadline: today + 120 + roll(n, 200), budget: 2000 });
    }
    if (n % EVERY_PACKAGE === 0) {
      group = `g${n / EVERY_PACKAGE}`;
      tier = [];
      st.tiers.push(tier);
      add(group, { ...base, title: `Package ${n / EVERY_PACKAGE}`, parent: project, kind: 'item' });
    }
    leaves++;
    const id = `t${n}`;
    const title = `Task ${n}`;
    if (n % 97 === 96) {
      const start = today + 14 + roll(n, 300);
      add(`x${n}`, { title: `Outage ${n}`, parent: null, kind: 'ext', pinS: start, pinE: start + 4, deps: [] });
      prev = `x${n}`;
      continue;
    }
    if (n % 23 === 22) {
      add(id, { ...base, title, parent: group, kind: 'ms', deps: prev ? [prev] : [] });
      prev = id;
      continue;
    }
    const est = 4 + (n * 7) % 30;
    const scope = (['must', 'should', 'could'] as const)[n % 3];
    const deps = n % 3 && prev ? [prev] : [];
    if (n % 5 === 0) {
      const spent = est + (n % 7) - 3;
      const doneOn = today - 3 - (n % 60);
      add(id, { ...base, title, parent: group, kind: 'item', est, spent, left: 0, scope, deps, doneOn, actualStart: doneOn - 5, touched: doneOn, log: [{ d: doneOn, h: spent }] });
    } else {
      const started = n % 5 === 1 && n % 50 < 12;
      const it: Item = { ...base, title, parent: group, kind: 'item', est, spent: started ? 3 : 0, left: started ? est - 2 : est, scope, deps };
      if (started) Object.assign(it, { actualStart: today - 4, touched: today - 2, log: [{ d: today - 4, h: 3 }] });
      if (n % 41 === 7) {
        it.pinS = today + 10 + roll(n, 300);
        it.pinE = it.pinS + 6;
      } else if (n % 37 === 5) it.pinS = today + 10 + roll(n, 300);
      add(id, it);
      tier.push(id);
      keyed.push(id);
    }
    prev = id;
  }

  if (levels) {
    const flat = st.tiers.flat();
    const size = Math.ceil(flat.length / levels);
    // The first levels are short, as real ones are: what matters now.
    st.tiers = Array.from({ length: levels }, (_, i) => flat.splice(0, i === levels - 1 ? flat.length : Math.ceil(size / 4)));
  }

  // Evenly spread along the schedule, at the date each task would land, a little later: pins that can be met.
  const a = analyze(st);
  const free = keyed.filter(id => all[id].pinS == null && all[id].pinE == null && all[id].deps!.length === 0);
  const want = Math.round(keyed.length * endPinned);
  for (let i = 0; i < want && free.length; i++) {
    const id = free[Math.floor((i * free.length) / want)];
    const end = a.by[id].end ?? today + 300;
    all[id].pinE = Math.min(end + 5 + (i % DAY_SPREAD), today + 700);
  }
  const final = analyze(st);
  for (const id in final.by) st.plan[id] = snapshot(final, st, id);
  return st;
}
