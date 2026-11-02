/** The budgets Node can measure, printed as JSON for dev/perf.mjs. Bundled with obsidian swapped for the fake. */
import { analyze } from '../src/engine';
import { SCENARIOS } from './perf-budgets';
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

const recalc = SCENARIOS.map(({ name, budget, seed }) => {
  const st = perfSeed(seed);
  for (let i = 0; i < WARM; i++) analyze(st);
  const samples = Array.from({ length: SAMPLES }, () => {
    const t = performance.now();
    analyze(st);
    return performance.now() - t;
  });
  return { name, budget, samples };
});

console.log(JSON.stringify({ onload, recalc }));
