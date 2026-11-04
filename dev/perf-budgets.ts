/** The spec's Performance table, in ms. `npm run perf` judges against these numbers as they stand. */
export const SPEC = {
  onload: 5,
  viewOpen500: 100,
  recalc200: 16,
  recalc1000: 50,
  /** 60 fps. */
  frame: 1000 / 60,
} as const;

/**
 * Only for `npm test` and `npm run perf -- --ci`, on machines nobody controls. It catches a change
 * that breaks a budget, not one that nears it. Plain `npm run perf` stays the judge and allows no margin.
 */
export const CI_MARGIN = 1.5;

export const CI = (budget: number) => budget * CI_MARGIN;

/** A frame interval lands on a vsync, give or take. One dropped frame doubles it, so this hides none. */
export const VSYNC_JITTER = 1.1;

/** Share of open tasks with only an end pin. The demo data has 1 in 20. */
export const END_PINNED = 0.05;

export const SCENARIOS = [
  { name: 'recalc 200 tasks', budget: SPEC.recalc200, seed: { tasks: 200 } },
  { name: `recalc 200 tasks, ${END_PINNED * 100}% end-pinned`, budget: SPEC.recalc200, seed: { tasks: 200, endPinned: END_PINNED } },
  { name: 'recalc 1000 tasks', budget: SPEC.recalc1000, seed: { tasks: 1000, weekly: 300 } },
  { name: `recalc 1000 tasks, ${END_PINNED * 100}% end-pinned`, budget: SPEC.recalc1000, seed: { tasks: 1000, weekly: 300, endPinned: END_PINNED } },
  // Most of a real vault sits in the last level, as new tasks land there.
  { name: `recalc 1000 tasks, ${END_PINNED * 100}% end-pinned, 3 levels`, budget: SPEC.recalc1000, seed: { tasks: 1000, weekly: 300, endPinned: END_PINNED, levels: 3 } },
] as const;

/** Past what one person can do in the 4-year horizon, so the whole horizon runs. Reported, as 1,000 tasks is 1,000 tasks. */
export const OVERLOADED = { name: `recalc 1000 tasks, ${END_PINNED * 100}% end-pinned, 40h week, past the horizon`, budget: SPEC.recalc1000, seed: { tasks: 1000, endPinned: END_PINNED } };

export const median = (xs: number[]) => pct(xs, 0.5);

/** Nearest rank. */
export function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
}
