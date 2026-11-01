/** Renders the real view against a fake Obsidian in headless Chromium: asserts behaviour, takes screenshots. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const dev = dirname(fileURLToPath(import.meta.url));
const shots = resolve(process.env.SHOTS ?? join(dev, '.out/shots'));
const viewport = { width: 1600, height: 900 };
mkdirSync(shots, { recursive: true });

await build({
  entryPoints: [join(dev, 'harness-entry.ts')],
  bundle: true,
  outfile: join(dev, '.out/harness.js'),
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  alias: { obsidian: join(dev, 'fake-obsidian.ts') },
  sourcemap: 'inline',
  logLevel: 'warning',
});

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
const problems = [];

async function open(query = 'theme=light', colorScheme = 'light', size = viewport) {
  const page = await browser.newPage({ viewport: size, colorScheme });
  page.on('console', m => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', e => problems.push(`page: ${e.message}\n${e.stack}`));
  await page.goto(`${pathToFileURL(join(dev, 'harness.html'))}?${query}`);
  await page.waitForFunction(() => window.tm);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  return page;
}

const shoot = async (page, name) => {
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.screenshot({ path: join(shots, `${name}.png`) });
};
const rowByTitle = (page, title) => page.locator('.tm-row', { has: page.locator(`.tm-t[title="${title}"]`) });
const railTitle = page => page.locator('.tm-rail h2').first().textContent();
const crumbs = page => page.locator('.tm-crumbs').textContent();
const rowCount = page => page.locator('.tm-row:not(.tm-sec)').count();
const canvasHash = page =>
  page.evaluate(() => {
    const c = document.querySelector('.tm-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
    return h;
  });
const loadHash = page =>
  page.evaluate(() => {
    const c = document.querySelector('.tm-canvas');
    const dpr = c.width / c.clientWidth;
    const d = c.getContext('2d').getImageData(0, c.height - 62 * dpr, c.width, 62 * dpr).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
    return h;
  });
const barPoint = (page, id) => page.evaluate(i => window.tm.view.gantt.barRect(i), id);

let checks = 0;
const check = async (name, fn) => {
  try {
    await fn();
    checks++;
  } catch (e) {
    problems.push(`${name}: ${e.message}`);
  }
};

// Behaviour. Tall enough that the column mounts every seed row.
{
  const tall = { width: 1600, height: 1300 };
  const page = await open('theme=light', 'light', tall);
  await check('top level', async () => {
    assert.equal((await crumbs(page)).trim(), 'All projects');
    assert.equal(await page.locator('.tm-up').isDisabled(), true);
    assert.equal(await railTitle(page), 'All projects');
    assert.equal(await rowByTitle(page, 'CAN stack port').count(), 1);
    assert.equal(await page.locator('.tm-row.tm-sec').textContent(), 'External');
    assert.match(await rowByTitle(page, 'Test bench recalibration').locator('.tm-s').textContent(), /^ext$/);
  });
  await check('canvas paints', async () => {
    const ink = await page.evaluate(() => {
      const c = document.querySelector('.tm-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 97) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
      return seen.size;
    });
    assert.ok(ink > 8, `only ${ink} colours on the canvas`);
  });
  await check('legend swatches have size, and the column foot fits', async () => {
    const sizes = await page.locator('.tm-legend i').evaluateAll(els => els.map(e => e.getBoundingClientRect()).map(r => r.width * r.height));
    assert.ok(sizes.length >= 5 && sizes.every(a => a > 0), `swatches ${sizes}`);
    const foot = await page.locator('.tm-tree-foot').evaluate(e => [e.scrollHeight, e.clientHeight]);
    assert.ok(foot[0] <= foot[1], `foot ${foot}`);
  });
  await check('prototype-only controls are absent', async () => {
    const text = await page.locator('.tm-root').textContent();
    for (const word of ['+1 day', 'Reset', 'Stress', 'Theme', 'Scenarios']) assert.ok(!text.includes(word), word);
  });
  await check('click selects, Esc clears, view unchanged', async () => {
    const before = await rowCount(page);
    await rowByTitle(page, 'CAN stack port').click();
    assert.equal(await railTitle(page), 'CAN stack port');
    assert.equal(await page.locator('.tm-row.tm-selected').count(), 1);
    assert.equal(await rowCount(page), before);
    assert.equal((await crumbs(page)).trim(), 'All projects');
    await page.keyboard.press('Escape');
    assert.equal(await railTitle(page), 'All projects');
  });
  await check('selecting a parent shows its overview, not a focus', async () => {
    await rowByTitle(page, 'Firmware').locator('.tm-t').click();
    assert.equal(await railTitle(page), 'Firmware');
    assert.equal((await crumbs(page)).trim(), 'All projects');
    await page.keyboard.press('Escape');
  });
  await check('focus and up, by button and by Esc', async () => {
    const row = rowByTitle(page, 'Sensor Gateway v2');
    await row.hover();
    await row.locator('.tm-fb').click();
    assert.match(await crumbs(page), /All projects\s*›\s*Sensor Gateway v2/);
    assert.equal(await rowByTitle(page, 'Sensor Gateway v2').count(), 0);
    assert.equal(await page.locator('.tm-up').isDisabled(), false);
    const fw = rowByTitle(page, 'Firmware');
    await fw.hover();
    await fw.locator('.tm-fb').click();
    assert.match(await crumbs(page), /Firmware/);
    await page.keyboard.press('Escape');
    assert.match(await crumbs(page), /Sensor Gateway v2$/);
    await page.locator('.tm-up').click();
    assert.equal((await crumbs(page)).trim(), 'All projects');
  });
  await check('focus keeps only referenced externals', async () => {
    const dp = rowByTitle(page, 'Data Pipeline Migration');
    await dp.hover();
    await dp.locator('.tm-fb').click();
    assert.equal(await page.locator('.tm-row.tm-sec').count(), 0);
    await page.locator('.tm-up').click();
  });
  await check('collapse button is at least 28 by 24 and collapses', async () => {
    const row = rowByTitle(page, 'Firmware');
    const box = await row.locator('.tm-col').boundingBox();
    assert.ok(box.width >= 28 && box.height >= 24, JSON.stringify(box));
    await row.locator('.tm-col').click();
    assert.equal(await rowByTitle(page, 'SPI sensor driver').count(), 0);
    await rowByTitle(page, 'Firmware').locator('.tm-col').click();
    assert.equal(await rowByTitle(page, 'SPI sensor driver').count(), 1);
  });
  await check('eye sits in one column at every depth', async () => {
    const xs = await page.locator('.tm-row:not(.tm-sec) .tm-eye').evaluateAll(els => [...new Set(els.map(e => e.getBoundingClientRect().left))]);
    assert.equal(xs.length, 1, `eye at ${xs}`);
  });
  await check('eye hides, the list restores, and hidden work still counts', async () => {
    const conflicts = await page.locator('.tm-status').textContent();
    await rowByTitle(page, 'Validation').locator('.tm-eye').click();
    assert.equal(await rowByTitle(page, 'HIL test suite').count(), 0);
    assert.match(await page.locator('.tm-hidden-btn').textContent(), /1 hidden/);
    assert.equal(await page.locator('.tm-status').textContent(), conflicts);
    await rowByTitle(page, 'Firmware').locator('.tm-col').click();
    await rowByTitle(page, 'Protocol').count();
    await page.locator('.tm-hidden-btn').click();
    assert.match(await page.locator('.tm-hidden-list').textContent(), /Validation/);
    await shoot(page, 'hidden-list-light');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.tm-hidden-list').count(), 0);
    await page.locator('.tm-hidden-btn').click();
    await page.locator('.tm-hidden-list button').click();
    assert.equal(await rowByTitle(page, 'HIL test suite').count(), 1);
    await rowByTitle(page, 'Firmware').locator('.tm-col').click();
  });
  await check('bar: tooltip, click selects, double-click opens the note', async () => {
    const p = await barPoint(page, 'dp.etl');
    await page.mouse.move(p.x, p.y);
    const tip = page.locator('.tm-tip');
    assert.equal(await tip.isVisible(), true);
    assert.match(await tip.textContent(), /ETL jobs.*Forecast.*Plan/s);
    await page.mouse.click(p.x, p.y);
    assert.equal(await railTitle(page), 'ETL jobs');
    await page.mouse.dblclick(p.x, p.y);
    assert.deepEqual(await page.evaluate(() => window.tm.app.workspace.opened), ['dp.etl']);
    await page.mouse.move(5, 5);
    assert.equal(await tip.isVisible(), false);
    await page.keyboard.press('Escape');
  });
  await check('row double-click opens the note', async () => {
    await rowByTitle(page, 'Runbook').locator('.tm-t').dblclick();
    assert.deepEqual(await page.evaluate(() => window.tm.app.workspace.opened), ['dp.etl', 'dp.doc']);
    await page.keyboard.press('Escape');
  });
  await check('external: selecting shades its dates', async () => {
    const before = await canvasHash(page);
    await rowByTitle(page, 'Test bench recalibration').locator('.tm-t').click();
    assert.equal(await railTitle(page), 'Test bench recalibration');
    assert.notEqual(await canvasHash(page), before);
    await page.keyboard.press('Escape');
  });
  await check('zoom and axis redraw, without recalculating', async () => {
    const runs = await page.evaluate(() => window.tm.view.gantt.recomputes);
    const before = await canvasHash(page);
    await page.locator('.tm-seg button', { hasText: /^W$/ }).click();
    assert.notEqual(await canvasHash(page), before);
    await page.locator('.tm-seg button', { hasText: /^Q$/ }).click();
    await page.locator('.tm-seg button', { hasText: /^M$/ }).click();
    const date = await canvasHash(page);
    await page.locator('.tm-seg button', { hasText: /^CW$/ }).click();
    assert.notEqual(await canvasHash(page), date);
    await page.locator('.tm-seg button', { hasText: /^Date$/ }).click();
    await page.evaluate(() => { document.querySelector('.tm-scroller').scrollLeft += 200; });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await page.evaluate(() => window.tm.view.gantt.recomputes), runs);
  });
  await check('ctrl+wheel zooms around the cursor', async () => {
    const box = await page.locator('.tm-scroller').boundingBox();
    const x = box.x + 300;
    const dayAt = () => page.evaluate(px => { const s = document.querySelector('.tm-scroller'); const g = window.tm.view.gantt; return (s.scrollLeft + px) / g.ppd; }, 300);
    const before = await dayAt();
    const ppd = await page.evaluate(() => window.tm.view.gantt.ppd);
    await page.mouse.move(x, box.y + 200);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.ok((await page.evaluate(() => window.tm.view.gantt.ppd)) > ppd);
    assert.ok(Math.abs((await dayAt()) - before) < 0.3, 'day under the cursor moved');
    await page.locator('.tm-seg button', { hasText: /^M$/ }).click();
  });
  await check('wheel over the column scrolls the chart too', async () => {
    await page.setViewportSize({ width: 1600, height: 500 });
    await page.mouse.move(100, 300);
    await page.mouse.wheel(0, 120);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.ok((await page.evaluate(() => document.querySelector('.tm-scroller').scrollTop)) > 0);
    await page.setViewportSize(tall);
    await page.evaluate(() => { document.querySelector('.tm-scroller').scrollTop = 0; });
  });
  await check('load strip: override steps the line and gets a label', async () => {
    const before = await loadHash(page);
    await page.evaluate(() => {
      const s = window.tm.store.state.settings;
      const w = Math.floor((s.holidays[0] + 3) / 7);
      s.weekCap = { [w - 6]: 24, [w - 3]: 0 };
      window.tm.store.emit();
    });
    assert.notEqual(await loadHash(page), before);
    await shoot(page, 'override-light');
    await page.evaluate(() => { window.tm.store.state.settings.weekCap = {}; window.tm.store.emit(); });
  });
  await check('status bar reports a store change', async () => {
    await page.evaluate(() => { window.tm.store.state.items['dp.etl'].left += 40; window.tm.store.emit(); });
    assert.match(await page.locator('.tm-status').textContent(), /Forecast moved on \d+ task/);
    await page.evaluate(() => { window.tm.store.state.items['dp.etl'].left -= 40; window.tm.store.emit(); });
  });
  await check('selection on a deleted note clears', async () => {
    await rowByTitle(page, 'Runbook').locator('.tm-t').click();
    await page.evaluate(() => { const s = window.tm.store.state; delete s.items['dp.doc']; s.tiers = s.tiers.map(t => t.filter(i => i !== 'dp.doc')); window.tm.store.emit(); });
    assert.equal(await railTitle(page), 'All projects');
  });
  await check('theme change reaches the canvas', async () => {
    const before = await canvasHash(page);
    await page.evaluate(() => {
      document.body.classList.replace('theme-light', 'theme-dark');
      window.tm.app.workspace.trigger('css-change');
    });
    assert.notEqual(await canvasHash(page), before);
  });
  await page.close();
}

await check('empty vault', async () => {
  const page = await open('theme=light&empty=1');
  assert.equal(await rowCount(page), 0);
  assert.equal(await railTitle(page), 'All projects');
  await shoot(page, 'empty-light');
  await page.locator('.tm-seg button', { hasText: /^Q$/ }).click();
  const reaches = await page.evaluate(() => {
    const c = document.querySelector('.tm-canvas');
    const dpr = c.width / c.clientWidth;
    const x = c.width - Math.round(10 * dpr);
    const top = c.height - Math.round(60 * dpr);
    const d = c.getContext('2d').getImageData(x, top, 1, c.height - top).data;
    const first = d.slice(0, 3).join();
    for (let i = 4; i < d.length; i += 4) if (d.slice(i, i + 3).join() !== first) return true;
    return false;
  });
  assert.ok(reaches, 'capacity line stops short of the right edge');
  await page.close();
});

await check('windowed column at 1,110 items', async () => {
  const page = await open('theme=light&big=1');
  const openMs = await page.evaluate(() => window.tm.openMs);
  console.log(`open, 1,110 items: ${openMs.toFixed(0)} ms`);
  assert.ok((await page.locator('.tm-row').count()) < 60);
  await page.evaluate(() => { document.querySelector('.tm-scroller').scrollTop = 20000; });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.ok((await page.locator('.tm-row').count()) < 60);
  assert.equal(await page.locator('.tm-row').first().textContent().then(t => t.includes('Project 0')), false);
  await page.close();
});

// Screenshots
for (const theme of ['light', 'dark']) {
  await check(`screenshots ${theme}`, async () => {
    const page = await open(`theme=${theme}`, theme);
    await shoot(page, `top-${theme}`);
    await rowByTitle(page, 'CAN transceiver debug').locator('.tm-t').click();
    await shoot(page, `task-${theme}`);
    await page.keyboard.press('Escape');
    const row = rowByTitle(page, 'Sensor Gateway v2');
    await row.hover();
    await row.locator('.tm-fb').click();
    await page.mouse.move(800, 5);
    await shoot(page, `focused-${theme}`);
    await rowByTitle(page, 'EMC pre-scan (lab booked)').locator('.tm-t').click();
    await shoot(page, `focused-task-${theme}`);
    await page.locator('.tm-seg button', { hasText: /^Q$/ }).click();
    await page.locator('.tm-seg button', { hasText: /^CW$/ }).click();
    await shoot(page, `quarter-cw-${theme}`);
    await page.close();

    const proto = await browser.newPage({ viewport, colorScheme: theme });
    await proto.goto(pathToFileURL(resolve(dev, '../prototype/taskmaster-prototype.html')).href);
    await proto.screenshot({ path: join(shots, `prototype-${theme}.png`) });
    await proto.close();
  });
}

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s), ${checks} checks passed`);
  process.exit(1);
}
console.log(`${checks} checks passed, no console errors. Screenshots: ${shots}`);
