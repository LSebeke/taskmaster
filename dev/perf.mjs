/**
 * `npm run perf`: every budget in the spec's Performance table, in Node and in headless Chromium through
 * the harness. Judged at the spec's own numbers on p95, or with the CI margin under `--ci`. Exits 1 when
 * anything is over. Raw samples: dev/.out/perf.json. CHROMIUM picks the browser binary.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const dev = dirname(fileURLToPath(import.meta.url));
const out = join(dev, '.out');
mkdirSync(out, { recursive: true });

const common = { bundle: true, target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact', alias: { obsidian: join(dev, 'fake-obsidian.ts') }, logLevel: 'warning' };
await build({ ...common, entryPoints: [join(dev, 'harness-entry.ts')], outfile: join(out, 'harness.js'), format: 'iife' });
await build({ ...common, entryPoints: [join(dev, 'perf-plugin-entry.ts')], outfile: join(out, 'perf-plugin.js'), format: 'iife' });
await build({ ...common, entryPoints: [join(dev, 'perf-node.ts')], outfile: join(out, 'perf-node.mjs'), format: 'esm', platform: 'node' });
await build({ entryPoints: [join(dev, 'perf-budgets.ts')], outfile: join(out, 'perf-budgets.mjs'), format: 'esm', logLevel: 'warning' });
const { CI_MARGIN, OVERLOADED, SCENARIOS, SPEC, END_PINNED, VSYNC_JITTER, median, pct } = await import(pathToFileURL(join(out, 'perf-budgets.mjs')));

const margin = process.argv.includes('--ci') ? CI_MARGIN : 1;
const OPEN_SAMPLES = 15;
const ONLOAD_SAMPLES = 15;
const RECALC_WARM = 10;
const RECALC_SAMPLES = 40;
const FRAMES = 240;
const VIEW = { width: 1600, height: 900 };
const OPEN_SEED = { items: 500, endPinned: END_PINNED };
const LARGE_SEED = { tasks: 1000, weekly: 300, endPinned: END_PINNED };

const rows = [];
const raw = {};
function report(where, name, samples, budget, unit = 'ms') {
  const row = { where, name, budget, n: samples.length, median: median(samples), p95: pct(samples, 0.95), max: Math.max(...samples), unit };
  rows.push(row);
  raw[`${where}: ${name}`] = samples.map(x => Math.round(x * 1000) / 1000);
  return row;
}

const node = JSON.parse(execFileSync('node', [join(out, 'perf-node.mjs')], { encoding: 'utf8', maxBuffer: 1 << 26 }));
report('node', 'onload', node.onload, SPEC.onload);
for (const r of node.recalc) report('node', r.name, r.samples, r.budget);
for (const r of node.signals) report('node', `${r.name} (no budget)`, r.samples);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const url = seed => `${pathToFileURL(join(dev, 'harness.html'))}?theme=light&perf=${encodeURIComponent(JSON.stringify(seed))}`;
const problems = [];

async function fresh(seed) {
  const page = await browser.newPage({ viewport: VIEW });
  page.on('console', m => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', e => problems.push(`page: ${e.message}`));
  await page.goto(url(seed));
  await page.waitForFunction(() => window.tm, null, { timeout: 60_000 });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  return page;
}

// Onload: a fresh page each time, as Obsidian's start is cold.
{
  const onload = [];
  const evaluate = [];
  for (let i = 0; i < ONLOAD_SAMPLES; i++) {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.evaluate(() => (window.before = performance.now()));
    await page.addScriptTag({ path: join(out, 'perf-plugin.js') });
    const r = await page.evaluate(() => ({ ...window.perfPlugin, before: window.before }));
    onload.push(r.onload);
    evaluate.push(r.evaluated - r.before);
    await page.close();
  }
  report('chromium', 'onload', onload, SPEC.onload);
  report('chromium', 'main.js parse and evaluate (no budget)', evaluate);
}

// View open: 500 items, cold, to the frame with the view on screen.
{
  const paint = [];
  const sync = [];
  const load = [];
  for (let i = 0; i < OPEN_SAMPLES; i++) {
    const page = await fresh(OPEN_SEED);
    const r = await page.evaluate(() => ({ paintMs: window.tm.paintMs, openMs: window.tm.openMs, loadMs: window.tm.loadMs, items: Object.keys(window.tm.store.state.items).length }));
    if (r.items !== OPEN_SEED.items) problems.push(`view open had ${r.items} items`);
    paint.push(r.paintMs);
    sync.push(r.openMs);
    load.push(r.loadMs);
    await page.close();
  }
  report('chromium', 'view open 500 items, first full paint', paint, SPEC.viewOpen500);
  report('chromium', 'view open 500 items, script only (no budget)', sync);
  report('chromium', 'store load 500 notes, before view open (no budget)', load);
}

// Recalculation.
{
  const page = await fresh({ tasks: 10 });
  for (const { name, budget, seed } of [...SCENARIOS, OVERLOADED]) {
    const samples = await page.evaluate(([s, w, n]) => window.tm.recalc(s, w, n), [seed, RECALC_WARM, RECALC_SAMPLES]);
    report('chromium', name, samples, budget);
  }
  await page.close();
}

/** Runs in the page. Steps a gesture once per frame and brackets the app's own frame callback. */
async function gesture([kind, frames]) {
  const scroller = document.querySelector('.tm-scroller');
  const gantt = window.tm.view.gantt;
  const store = window.tm.store;
  let notified = 0;
  const unsubscribe = store.subscribe(() => notified++);
  const recomputes = gantt.recomputes;
  const signals = gantt.signals.runs;
  const box = scroller.getBoundingClientRect();
  const works = [];
  const intervals = [];
  let begin = 0;
  let extra = 0;
  let end = 0;
  let sinceStart = 0;
  // Scroll events run before frame callbacks, and a callback added then runs that frame. In order: `begin`, the app's paint, `end`.
  const opening = () => requestAnimationFrame(() => (begin = performance.now()));
  const closing = () => requestAnimationFrame(() => (end = performance.now()));
  document.addEventListener('scroll', opening, { capture: true });
  scroller.addEventListener('scroll', closing);

  const step = i => {
    if (kind === 'scroll') scroller.scrollTop = 1000 + 900 * Math.sin(i / 40);
    if (kind === 'pan') scroller.scrollLeft = 1500 + 900 * Math.sin(i / 40);
    if (kind === 'zoom') {
      const t = performance.now();
      const zoomIn = i % 40 < 20;
      scroller.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: zoomIn ? -100 : 100, clientX: box.left + 500, clientY: box.top + 300, bubbles: true, cancelable: true }));
      extra = performance.now() - t;
    }
  };

  await new Promise(done => {
    let i = 0;
    let last = performance.now();
    const frame = now => {
      if (i) {
        intervals.push(now - last);
        works.push((end > begin ? end - begin : 0) + sinceStart);
      }
      last = now;
      begin = end = 0;
      if (i++ === frames) return done();
      step(i);
      sinceStart = extra;
      extra = 0;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  document.removeEventListener('scroll', opening, { capture: true });
  scroller.removeEventListener('scroll', closing);
  unsubscribe();
  return { works, intervals, recomputes: gantt.recomputes - recomputes, signals: gantt.signals.runs - signals, notified };
}

/** Frame times. `nothing` proves no recalculation: schedule runs, signal runs, store notifications. */
async function frames(label, seed) {
  const page = await fresh(seed);
  for (const kind of ['scroll', 'pan', 'zoom']) {
    const r = await page.evaluate(gesture, [kind, FRAMES]);
    const paints = r.works.filter(x => x > 0);
    if (paints.length < FRAMES * 0.8) problems.push(`${label} ${kind}: only ${paints.length} of ${FRAMES} frames painted`);
    report('chromium', `${kind} ${label}, work per frame`, paints, SPEC.frame);
    report('chromium', `${kind} ${label}, frame interval`, r.intervals, SPEC.frame * VSYNC_JITTER);
    const recalculated = r.recomputes + r.signals + r.notified;
    rows.push({ where: 'chromium', name: `${kind} ${label}, recalculations`, budget: 0, n: FRAMES, median: recalculated, p95: recalculated, max: recalculated, unit: 'runs' });
  }
  await page.close();
}
await frames('500 items', OPEN_SEED);
await frames('1000 tasks', LARGE_SEED);

// A drag step, for the record: the spec asks for no spinner, and each step recalculates.
{
  const page = await fresh(LARGE_SEED);
  const point = await page.evaluate(() => {
    const { store, view: { gantt } } = window.tm;
    const box = document.querySelector('.tm-scroller').getBoundingClientRect();
    for (const id of Object.keys(window.tm.store.state.items)) {
      const it = store.state.items[id];
      if (it.kind !== 'item' || !(it.left > 0) || it.pinS != null) continue;
      const r = gantt.barRect(id, true);
      if (r && r.x0 > box.left + 200 && r.x1 < box.right - 200 && r.y > box.top + 60 && r.y < box.bottom - 80) return { x: r.x, y: r.y };
    }
    return null;
  });
  if (!point) problems.push('drag: no bar on screen');
  else {
    await page.evaluate(() => {
      window.steps = [];
      let t = 0;
      addEventListener('pointermove', () => (t = performance.now()), { capture: true });
      addEventListener('pointermove', () => window.steps.push(performance.now() - t));
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    const ppd = await page.evaluate(() => window.tm.view.gantt.ppd);
    for (let i = 1; i <= 40; i++) await page.mouse.move(point.x + Math.round(ppd * (i % 20)), point.y);
    await page.keyboard.press('Escape').catch(() => {});
    const steps = await page.evaluate(() => window.steps);
    await page.mouse.up();
    report('chromium', 'drag step 1000 tasks, 5% end-pinned (no budget)', steps.slice(1));
  }
  await page.close();
}
await browser.close();

const verdict = r => (r.budget == null ? '' : r.p95 <= r.budget * margin ? 'ok' : 'OVER');
const f = x => (Number.isInteger(x) ? String(x) : x.toFixed(2));
const width = Math.max(...rows.map(r => `${r.where} ${r.name}`.length));
if (margin !== 1) console.log(`Judged at budget x ${margin}, for CI. The budget column is the spec's.`);
console.log(`${'measure'.padEnd(width)}  budget  median     p95     max    n`);
for (const r of rows) {
  const cells = [r.budget == null ? '-' : f(r.budget), f(r.median), f(r.p95), f(r.max)].map(c => c.padStart(6));
  console.log(`${`${r.where} ${r.name}`.padEnd(width)}  ${cells.join('  ')}  ${String(r.n).padStart(3)} ${r.unit} ${verdict(r)}`);
}
for (const [name, samples] of Object.entries(raw)) if (samples.length <= 40) console.log(`raw ${name}: ${samples.join(' ')}`);
writeFileSync(join(out, 'perf.json'), JSON.stringify({ rows, raw }, null, 1));
console.log(`raw samples: ${join(out, 'perf.json')}`);
// On GitHub Actions, the same table on the run's summary page.
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = rows.map(r => `| ${r.where} ${r.name} | ${r.budget == null ? '-' : f(r.budget)} | ${f(r.median)} | ${f(r.p95)} | ${f(r.max)} | ${r.unit} | ${verdict(r)} |`);
  const head = `### Perf${margin !== 1 ? ` (budget x ${margin})` : ''}\n\n| measure | budget | median | p95 | max | unit | |\n|---|--:|--:|--:|--:|---|---|\n`;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${head}${md.join('\n')}\n`);
}
for (const p of problems) console.error(`problem: ${p}`);
const over = rows.filter(r => verdict(r) === 'OVER');
if (over.length || problems.length) {
  console.error(`${over.length} measure(s) over budget`);
  process.exit(1);
}
