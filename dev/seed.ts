import { analyze, dayOf as D, leavesOf, snapshot, type Item, type State } from '../src/engine';

/** The prototype's demo data, typed. */
export function seed(): State {
  const items: Record<string, Item> = {};
  const add = (id: string, title: string, parent: string | null, o: Partial<Item> = {}) =>
    (items[id] = { title, parent, kind: 'item', scope: 'must', deps: [], todos: [], notes: [], ...o });
  const T = (id: string, title: string, parent: string, est: number, o: Partial<Item> = {}) =>
    add(id, title, parent, { est, spent: 0, left: est, ...o });
  const today = D('2026-11-02');
  const ago = (n: number) => today - n;

  add('gw', 'Sensor Gateway v2', null, { deadline: D('2026-12-18'), budget: 330, notes: ['Gateway v2 PRD', 'Decision log'] });
  add('gw.hw', 'Hardware bring-up', 'gw');
  T('gw.hw.pow', 'Power rail validation', 'gw.hw', 16, { spent: 21, left: 0, actualStart: ago(20), doneOn: ago(10) });
  T('gw.hw.can', 'CAN transceiver debug', 'gw.hw', 24, {
    spent: 20,
    left: 12,
    actualStart: ago(9),
    touched: ago(1),
    notes: ['CAN bus errata'],
    todos: [
      { t: 'Scope termination at 1 Mbit', done: true },
      { t: 'Check common-mode choke footprint', done: false },
      { t: 'Ask vendor about errata 4.2', done: false },
    ],
  });
  T('gw.hw.emc', 'EMC pre-scan (lab booked)', 'gw.hw', 16, { deps: ['gw.hw.can'], pinS: D('2026-11-16'), pinE: D('2026-11-18'), notes: ['EMC lab booking'] });
  add('gw.fw', 'Firmware', 'gw');
  add('gw.fw.drv', 'Drivers', 'gw.fw');
  T('gw.fw.drv.spi', 'SPI sensor driver', 'gw.fw.drv', 20, { spent: 22, left: 6, actualStart: ago(14), touched: ago(11), todos: [{ t: 'DMA for burst reads', done: false }] });
  T('gw.fw.drv.can', 'CAN stack port', 'gw.fw.drv', 30, { deps: ['gw.hw.can'] });
  T('gw.fw.drv.flash', 'Flash log storage', 'gw.fw.drv', 18, { scope: 'should' });
  add('gw.fw.pr', 'Protocol', 'gw.fw');
  T('gw.fw.pr.frame', 'Frame format + CRC', 'gw.fw.pr', 14, { deps: ['gw.fw.drv.spi'], notes: ['Wire format'] });
  T('gw.fw.pr.ota', 'OTA updates', 'gw.fw.pr', 40, { deps: ['gw.fw.pr.frame'], scope: 'could' });
  T('gw.fw.pr.dbg', 'Remote diagnostics', 'gw.fw.pr', 24, { deps: ['gw.fw.pr.frame'], scope: 'could' });
  add('gw.val', 'Validation', 'gw');
  T('gw.val.hil', 'HIL test suite', 'gw.val', 32, { deps: ['gw.fw.drv.can', 'gw.fw.pr.frame', 'rig.ms', 'x.bench'] });
  T('gw.val.soak', '72h soak run', 'gw.val', 8, { deps: ['gw.val.hil'] });
  add('gw.val.rc', 'Release candidate', 'gw.val', { kind: 'ms', deps: ['gw.val.soak'] });

  add('rig', 'Test Rig Automation', null, { deadline: D('2027-01-29'), budget: 110 });
  add('rig.fx', 'Fixture control', 'rig');
  T('rig.fx.relay', 'Relay board wiring', 'rig.fx', 12, { spent: 15, left: 0, actualStart: ago(25), doneOn: ago(16) });
  T('rig.fx.py', 'Python instrument driver', 'rig.fx', 18, { spent: 8, left: 14, actualStart: ago(7), touched: ago(2) });
  add('rig.sq', 'Sequencer', 'rig');
  T('rig.sq.yaml', 'YAML test definitions', 'rig.sq', 16, { deps: ['rig.fx.py'] });
  T('rig.sq.rep', 'Report generator', 'rig.sq', 20, { deps: ['rig.sq.yaml'], scope: 'should' });
  T('rig.sq.ui', 'Web dashboard', 'rig.sq', 30, { deps: ['rig.sq.rep'], scope: 'could' });
  add('rig.ms', 'Rig ready for HIL', 'rig', { kind: 'ms', deps: ['rig.sq.yaml'] });

  add('dp', 'Data Pipeline Migration', null, { deadline: D('2026-12-04'), budget: 90 });
  T('dp.sch', 'Schema design', 'dp', 12, { spent: 12, left: 0, actualStart: ago(18), doneOn: ago(12) });
  T('dp.etl', 'ETL jobs', 'dp', 30, {
    spent: 10,
    left: 24,
    actualStart: ago(6),
    touched: ago(1),
    todos: [
      { t: 'Idempotent upserts', done: true },
      { t: 'Retry policy', done: false },
    ],
  });
  T('dp.back', 'Backfill 3 years', 'dp', 16, { deps: ['dp.etl'] });
  T('dp.cut', 'Production cutover', 'dp', 8, { deps: ['dp.back'], pinE: D('2026-12-04') });
  T('dp.doc', 'Runbook', 'dp', 6, { scope: 'should' });

  add('x.bench', 'Test bench recalibration', null, { kind: 'ext', pinS: D('2026-11-30'), pinE: D('2026-12-04'), notes: ['Vendor call notes'], scope: undefined });

  for (const it of Object.values(items)) {
    if (!it.spent) continue;
    const n = Math.max(1, Math.round(it.spent / 5));
    const each = Math.round((it.spent / n) * 2) / 2;
    it.log = [];
    for (let i = 0, d = it.actualStart!; i < n; i++, d++) {
      while (![1, 2, 3, 4, 5].includes((d + 4) % 7)) d++;
      it.log.push({ d, h: i === n - 1 ? it.spent - each * (n - 1) : each });
    }
  }

  const lead = ['gw.hw.can', 'dp.etl'];
  const second = ['gw.fw.drv.spi', 'rig.fx.py'];
  const open = Object.keys(items).filter(i => items[i].left! > 0);
  const st: State = {
    items,
    plan: {},
    today,
    settings: { weekly: 40, staleDays: 7, holidays: ['2026-12-24', '2026-12-25', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01'].map(D) },
    tiers: [lead, second, open.filter(l => !lead.includes(l) && !second.includes(l))],
  };

  // A baseline taken before estimates grew, so the demo has real variance.
  const earlier: State = structuredClone(st);
  for (const [id, it] of Object.entries(earlier.items)) if (it.left) it.left *= id.startsWith('gw') ? 0.72 : 0.9;
  const a = analyze(earlier);
  for (const id in items) {
    if (!a.by[id] || items[id].kind === 'ext') continue;
    st.plan[id] = snapshot(a, earlier, id);
    if (items[id].est != null) st.plan[id].hours = items[id].est;
  }
  for (const id in items) {
    if (items[id].kind === 'item' && items[id].est == null) st.plan[id]!.hours = leavesOf(st, id).reduce((x, l) => x + (st.plan[l]?.hours ?? 0), 0);
  }
  return st;
}

/** Small enough to work out by hand, at the spec's 30h/week. The harness's expected values come from this. */
export function miniSeed(): State {
  const today = D('2026-11-02');
  const item = (title: string, parent: string | null, o: Partial<Item> = {}): Item => ({ title, parent, kind: 'item', scope: 'must', deps: [], todos: [], notes: [], ...o });
  const task = (title: string, parent: string, scope: Item['scope']) => item(title, parent, { est: 12, spent: 0, left: 12, scope });
  const items: Record<string, Item> = {
    'mini.p': item('Alpha', null, { deadline: D('2026-11-06') }),
    'mini.d': item('Done one', 'mini.p', { est: 10, spent: 15, left: 0, doneOn: today - 3, touched: today - 3, actualStart: today - 10, log: [{ d: today - 10, h: 15 }] }),
    'mini.m': task('Must one', 'mini.p', 'must'),
    'mini.s': task('Should one', 'mini.p', 'should'),
    'mini.c': task('Could one', 'mini.p', 'could'),
    'mini.q': item('Beta', null),
    'mini.e': item('Blocked task', 'mini.q', { est: 6, spent: 0, left: 6, deps: ['mini.x'] }),
    'mini.x': { title: 'Bench outage', parent: null, kind: 'ext', pinS: today, pinE: today + 1, deps: [] },
  };
  return { items, plan: {}, today, settings: { weekly: 30, staleDays: 7, holidays: [] }, tiers: [['mini.e'], ['mini.m', 'mini.s', 'mini.c']] };
}

/** 1,110 items, for windowing. */
export function bigSeed(): State {
  const st: State = { items: {}, plan: {}, today: D('2026-11-02'), settings: { weekly: 300, staleDays: 7, holidays: [] }, tiers: [] };
  let prev: string | null = null;
  for (let p = 0; p < 10; p++) {
    const P = `p${p}`;
    st.items[P] = { title: `Project ${p}`, parent: null, kind: 'item' };
    for (let g = 0; g < 10; g++) {
      const G = `${P}g${g}`;
      st.items[G] = { title: `Package ${g}`, parent: P, kind: 'item' };
      const tier: string[] = [];
      for (let t = 0; t < 10; t++) {
        const id = `${G}t${t}`;
        const h = 4 + ((t * 7 + g * 3 + p) % 30);
        st.items[id] = { title: `Task ${p}.${g}.${t}`, parent: G, kind: 'item', est: h, spent: 0, left: h, deps: t % 3 && prev ? [prev] : [] };
        prev = id;
        tier.push(id);
      }
      st.tiers.push(tier);
    }
  }
  const a = analyze(st);
  for (const id in a.by) st.plan[id] = snapshot(a, st, id);
  return st;
}
