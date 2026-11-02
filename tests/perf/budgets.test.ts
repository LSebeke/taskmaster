import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/engine';
import { CI, median, SCENARIOS } from '../../dev/perf-budgets';
import { perfSeed } from '../../dev/perf-seed';

const WARM = 5;
const SAMPLES = 15;

/** Only a change that breaks a budget should fail here: `npm run perf` is the judge at the spec's numbers. */
describe('recalculation stays inside its budget', () => {
  it.each(SCENARIOS)('$name', ({ budget, seed }) => {
    const st = perfSeed(seed);
    for (let i = 0; i < WARM; i++) analyze(st);
    const times: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t = performance.now();
      analyze(st);
      times.push(performance.now() - t);
    }
    expect(median(times)).toBeLessThan(CI(budget));
  }, 120_000);
});
