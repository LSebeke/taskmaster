/** The budgets Node can measure, printed as JSON for dev/perf.mjs. Bundled with obsidian swapped for the fake. */
import { adjusted, analyze, externalImpact, mvp } from '../src/engine';
import { OVERLOADED, SCENARIOS } from './perf-budgets';
import { perfSeed } from './perf-seed';

const WARM = 10;
const SAMPLES = 40;
const ONLOAD_SAMPLES = 200;

const fakeElement = () => ({ style: {}, classList: { add() {} } });
Object.assign(globalThis, { document: { createElement: fakeElement } });

const { default: TaskmasterPlugin } = await import('../src/main');
const { FakeApp } = await import('./fake-obsidian');

const onload = Array.from({ length: ONLOAD_SAMPLES }, () => {
  const plugin = new TaskmasterPlugin(new FakeApp() as never, {} as never);
  const t = performance.now();
  plugin.onload();
  return performance.now() - t;
});

const timed = (run: () => void) => {
  for (let i = 0; i < WARM; i++) run();
  return Array.from({ length: SAMPLES }, () => {
    const t = performance.now();
    run();
    return performance.now() - t;
  });
};

const recalc = [...SCENARIOS, OVERLOADED].map(({ name, budget, seed }) => {
  const st = perfSeed(seed);
  return { name, budget, samples: timed(() => analyze(st)) };
});

// The panels that rerun the schedule, per panel on screen and cached by input hash. No budget of their own.
const st = perfSeed(SCENARIOS[3].seed);
const ext = Object.keys(st.items).find(id => st.items[id].kind === 'ext')!;
const signals = [
  { name: 'MVP signal, 1000 tasks', samples: timed(() => mvp(st, 'p0')) },
  { name: 'adjusted finish, 1000 tasks', samples: timed(() => adjusted(st, 'p0', 1.2)) },
  { name: 'external effect, 1000 tasks', samples: timed(() => externalImpact(st, ext)) },
];

console.log(JSON.stringify({ onload, recalc, signals }));
