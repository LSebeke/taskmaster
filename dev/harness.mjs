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
const barPoint = (page, id, fc = false) => page.evaluate(([i, f]) => window.tm.view.gantt.barRect(window.tm.path(i), f), [id, fc]);
const pathOf = (page, id) => page.evaluate(i => window.tm.path(i), id);
const note = (page, id) => page.evaluate(i => window.tm.note(i), id);
/** Lets writes, cache echoes and the recompute window pass. */
const settle = page => page.evaluate(() => new Promise(r => setTimeout(r, 120)));
const runs = page => page.evaluate(() => window.tm.view.gantt.recomputes);
const status = page => page.locator('.tm-changes').textContent();

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
    assert.deepEqual(await page.evaluate(() => window.tm.app.workspace.opened), [await pathOf(page, 'dp.etl')]);
    await page.mouse.move(5, 5);
    assert.equal(await tip.isVisible(), false);
    await page.keyboard.press('Escape');
  });
  await check('row double-click opens the note', async () => {
    await rowByTitle(page, 'Runbook').locator('.tm-t').dblclick();
    assert.deepEqual(await page.evaluate(() => window.tm.app.workspace.opened), [await pathOf(page, 'dp.etl'), await pathOf(page, 'dp.doc')]);
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
    const edit = (h6, h3) => page.evaluate(([a, b]) => {
      const { store, edits } = window.tm;
      const w = Math.floor((store.state.settings.holidays[0] + 3) / 7);
      store.apply(edits.setWeekCapacity(w - 6, a));
      store.apply(edits.setWeekCapacity(w - 3, b));
    }, [h6, h3]);
    await edit(24, 0);
    assert.notEqual(await loadHash(page), before);
    await shoot(page, 'override-light');
    await edit(null, null);
  });
  await check('status bar reports a store change', async () => {
    await page.evaluate(() => { const { tm } = window; tm.vault.change(tm.path('dp.etl'), { ...tm.note('dp.etl'), 'tm-left': 64 }); });
    await settle(page);
    assert.match(await page.locator('.tm-status').textContent(), /Forecast moved on \d+ task/);
    await page.evaluate(() => { const { tm } = window; tm.vault.change(tm.path('dp.etl'), { ...tm.note('dp.etl'), 'tm-left': 24 }); });
    await settle(page);
  });
  await check('selection on a deleted note clears', async () => {
    await rowByTitle(page, 'Runbook').locator('.tm-t').click();
    await page.evaluate(() => window.tm.vault.remove(window.tm.path('dp.doc')));
    await settle(page);
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

// Editing: everything below goes through real mouse and keyboard, the real store and a fake vault.
{
  const tall = { width: 1600, height: 1300 };
  const page = await open('theme=light', 'light', tall);
  const select = title => rowByTitle(page, title).locator('.tm-t').click();
  const undo = async () => {
    await page.mouse.move(5, 5);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Control+z');
    await settle(page);
  };
  const dragTo = async (from, to, steps = 12) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps });
  };
  const row = title => rowByTitle(page, title);
  const ppd = 7;

  await check('hover shows the link dot; drag a forecast body: live, overlays, pins both on drop, no second recalculation', async () => {
    const id = 'gw.fw.drv.flash';
    const bar = await barPoint(page, id, true);
    const topBefore = await page.locator('.tm-top').boundingBox();
    const treeBefore = await page.locator('.tm-tree').boundingBox();
    const hash = await canvasHash(page);
    await page.mouse.move(bar.x, bar.y);
    await shoot(page, 'drag-hover');
    await dragTo(bar, { x: bar.x + 14 * ppd, y: bar.y });
    await shoot(page, 'drag-body-mid');
    assert.match(await status(page), /Flash log storage: .* → .*: (forecast moved|no forecast change)/);
    assert.notEqual(await canvasHash(page), hash);
    assert.deepEqual(await page.locator('.tm-top').boundingBox(), topBefore);
    assert.deepEqual(await page.locator('.tm-tree').boundingBox(), treeBefore);
    assert.equal((await note(page, id))['tm-pin-start'], undefined, 'nothing written mid-drag');
    const mid = await barPoint(page, id, true);
    assert.ok(Math.abs(mid.x - (bar.x + 14 * ppd)) < 60, `bar follows: ${mid.x} vs ${bar.x}`);
    await page.mouse.up();
    const after = await runs(page);
    await settle(page);
    assert.equal(await runs(page), after, 'echo recalculated');
    const fm = await note(page, id);
    assert.ok(fm['tm-pin-start'] && fm['tm-pin-end'], JSON.stringify(fm));
    await shoot(page, 'drag-body-after');
    assert.match(await page.locator('.tm-undo').getAttribute('title'), /Dragged Flash log storage/);
    await undo();
    const back = await note(page, id);
    assert.equal(back['tm-pin-start'], undefined);
    assert.equal(back['tm-pin-end'], undefined);
    assert.match(await status(page), /^Undid: Dragged Flash log storage/);
  });

  await check('drag the end edge: pins only that edge', async () => {
    const id = 'dp.doc';
    const bar = await barPoint(page, id, true);
    assert.ok(bar.x1 - bar.x0 > 18, `bar is ${bar.x1 - bar.x0}px`);
    await dragTo({ x: bar.x1 - 2, y: bar.y }, { x: bar.x1 + 10 * ppd, y: bar.y });
    await shoot(page, 'drag-edge-mid');
    await page.mouse.up();
    await settle(page);
    const fm = await note(page, id);
    assert.ok(fm['tm-pin-end'], JSON.stringify(fm));
    assert.equal(fm['tm-pin-start'], undefined);
    await undo();
  });

  await check('an edge cannot pass the other edge', async () => {
    const id = 'dp.doc';
    const bar = await barPoint(page, id, true);
    await dragTo({ x: bar.x1 - 2, y: bar.y }, { x: bar.x0 - 40 * ppd, y: bar.y });
    await page.mouse.up();
    await settle(page);
    const pinE = await page.evaluate(i => window.tm.store.state.items[window.tm.path(i)].pinE, id);
    const startDay = Math.round(bar.x0 / ppd);
    const pinnedAt = Math.round((await barPoint(page, id, true)).x1 / ppd) - 1;
    assert.ok(pinE != null && pinnedAt >= startDay, `end pinned before start: ${pinnedAt} < ${startDay}`);
    await undo();
    const s = await barPoint(page, id, true);
    await dragTo({ x: s.x0 + 2, y: s.y }, { x: s.x1 + 60 * ppd, y: s.y });
    await page.mouse.up();
    await settle(page);
    const moved = await barPoint(page, id, true);
    assert.ok(moved.x0 <= s.x1 - ppd + 1, `start passed end: ${moved.x0} vs ${s.x1}`);
    await undo();
  });

  await check('external bar drags, moving what depends on it; Esc cancels a drag', async () => {
    const id = 'x.bench';
    const before = await note(page, id);
    const bar = await barPoint(page, id, true);
    await dragTo(bar, { x: bar.x + 21 * ppd, y: bar.y });
    await shoot(page, 'drag-external-mid');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await settle(page);
    assert.deepEqual(await note(page, id), before);
    await dragTo(bar, { x: bar.x + 21 * ppd, y: bar.y });
    await page.mouse.up();
    await settle(page);
    const fm = await note(page, id);
    assert.equal(fm['tm-pin-start'], '2026-12-21');
    assert.equal(fm['tm-pin-end'], '2026-12-25');
    await shoot(page, 'drag-external-after');
    await undo();
    assert.deepEqual(await note(page, id), before);
  });

  await check('plan bars, parents, milestones and finished tasks do not drag', async () => {
    const was = await page.evaluate(() => window.tm.store.undoLabel);
    for (const [id, fc] of [['dp.etl', false], ['gw.fw', true], ['gw.fw', false], ['gw.val.rc', true], ['dp.sch', true]]) {
      const bar = await barPoint(page, id, fc);
      assert.ok(bar, id);
      await dragTo(bar, { x: bar.x + 10 * ppd, y: bar.y }, 6);
      await page.mouse.up();
    }
    await settle(page);
    assert.equal(await page.evaluate(() => window.tm.store.undoLabel), was);
    await page.keyboard.press('Escape');
  });

  await check('a click on a bar still selects, and double-click opens the note', async () => {
    const bar = await barPoint(page, 'rig.fx.py', true);
    await page.mouse.click(bar.x, bar.y);
    assert.equal(await railTitle(page), 'Python instrument driver');
    await page.mouse.dblclick(bar.x, bar.y);
    assert.equal((await page.evaluate(() => window.tm.app.workspace.opened)).at(-1), await pathOf(page, 'rig.fx.py'));
    assert.equal(await page.evaluate(() => window.tm.store.undoLabel), null);
    await page.keyboard.press('Escape');
  });

  await check('drag from the dot: shows the consequence, adds the dependency, undoes', async () => {
    const from = await barPoint(page, 'dp.doc', true);
    const to = await barPoint(page, 'dp.etl', true);
    await dragTo(from.dot, { x: to.x, y: to.y });
    assert.match(await status(page), /ETL jobs would wait for Runbook/);
    await shoot(page, 'link-legal-mid');
    await page.mouse.up();
    await settle(page);
    const fm = await note(page, 'dp.etl');
    assert.deepEqual(fm['tm-deps'], ['[[Runbook]]']);
    assert.match(await status(page), /ETL jobs now waits for Runbook/);
    await shoot(page, 'link-after');
    await undo();
    assert.equal((await note(page, 'dp.etl'))['tm-deps'], undefined);
  });

  await check('drag from the dot onto an illegal target refuses and says why', async () => {
    const from = await barPoint(page, 'dp.cut', true);
    const to = await barPoint(page, 'dp.etl', true);
    const was = await page.evaluate(() => window.tm.store.undoLabel);
    await dragTo(from.dot, { x: to.x, y: to.y });
    assert.match(await status(page), /⚠ That would create a dependency loop/);
    await shoot(page, 'link-illegal-mid');
    await page.mouse.up();
    await settle(page);
    assert.equal(await page.evaluate(() => window.tm.store.undoLabel), was);
    const ext = await barPoint(page, 'x.bench', true);
    await dragTo(from.dot, { x: ext.x, y: ext.y });
    assert.match(await status(page), /External items have no dependencies/);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.tm.store.undoLabel), was);
  });

  await check('rail: total, left, log with date, edit and delete an entry', async () => {
    await select('Runbook');
    await page.getByLabel('Total hours').fill('10');
    await page.getByLabel('Total hours').press('Enter');
    await settle(page);
    let fm = await note(page, 'dp.doc');
    assert.equal(fm['tm-left'], 10);
    assert.equal(fm['tm-estimate'], 6);
    await page.getByLabel('Hours left', { exact: true }).fill('8');
    await page.getByLabel('Hours left', { exact: true }).blur();
    await settle(page);
    assert.equal((await note(page, 'dp.doc'))['tm-left'], 8);
    await page.getByLabel('Hours to log').fill('3');
    await page.getByLabel('Log date').fill('2026-11-03');
    await page.locator('.tm-log-form button').click();
    await settle(page);
    fm = await note(page, 'dp.doc');
    assert.deepEqual(fm['tm-log'], ['2026-11-03 3']);
    assert.equal(fm['tm-left'], 5);
    await shoot(page, 'rail-log');
    await page.getByLabel('Hours logged 3 Nov').fill('1');
    await page.getByLabel('Hours logged 3 Nov').blur();
    await settle(page);
    assert.equal((await note(page, 'dp.doc'))['tm-left'], 7);
    await page.getByLabel('Delete log entry 3 Nov').click();
    await settle(page);
    fm = await note(page, 'dp.doc');
    assert.deepEqual(fm['tm-log'], []);
    assert.equal(fm['tm-left'], 8);
  });

  await check('rail: Auto/Pinned per edge, deadline, scope', async () => {
    const edge = name => page.getByRole('group', { name: `${name} edge` });
    await edge('Start').getByText('Pinned').click();
    await settle(page);
    assert.ok((await note(page, 'dp.doc'))['tm-pin-start']);
    await page.getByLabel('Start pin').fill('2026-11-20');
    await page.getByLabel('Start pin').blur();
    await settle(page);
    assert.equal((await note(page, 'dp.doc'))['tm-pin-start'], '2026-11-20');
    await edge('Start').getByText('Auto').click();
    await settle(page);
    assert.equal((await note(page, 'dp.doc'))['tm-pin-start'], undefined);
    await edge('End').getByText('Pinned').click();
    await edge('End').getByText('Auto').click();
    await page.getByLabel('Deadline').fill('2026-12-11');
    await page.getByLabel('Deadline').blur();
    await page.getByLabel('Scope').selectOption('could');
    await settle(page);
    const fm = await note(page, 'dp.doc');
    assert.equal(fm['tm-deadline'], '2026-12-11');
    assert.equal(fm['tm-scope'], 'could');
    await shoot(page, 'rail-edited');
  });

  await check('rail: picker sorted, without cycles; add and remove a dependency', async () => {
    const pick = page.getByLabel('Add dependency');
    const groups = await pick.locator('optgroup').evaluateAll(g => g.map(x => x.label));
    assert.deepEqual(groups, [...groups].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
    assert.ok(groups.includes('External'));
    assert.ok(groups.includes('Sensor Gateway v2 › Firmware › Drivers'), groups.join('|'));
    const items = await pick.locator('optgroup[label="Sensor Gateway v2 › Firmware › Drivers"] option').allTextContents();
    assert.deepEqual(items, ['CAN stack port', 'Flash log storage', 'SPI sensor driver']);
    await select('ETL jobs');
    const options = await pick.locator('option').allTextContents();
    assert.ok(!options.includes('Production cutover'), 'cycle offered');
    assert.ok(!options.includes('ETL jobs'), 'itself offered');
    await pick.selectOption({ label: 'CAN stack port' });
    await settle(page);
    assert.deepEqual((await note(page, 'dp.etl'))['tm-deps'], ['[[CAN stack port]]']);
    await page.getByLabel('Remove dependency on CAN stack port').click();
    await settle(page);
    assert.deepEqual((await note(page, 'dp.etl'))['tm-deps'], []);
    await page.keyboard.press('Escape');
  });

  await check('parent details: budget, deadline and dependencies', async () => {
    await select('Firmware');
    await page.getByLabel('Budget').fill('120');
    await page.getByLabel('Budget').blur();
    await settle(page);
    assert.equal((await note(page, 'gw.fw'))['tm-budget'], 120);
    await page.keyboard.press('Escape');
  });

  await check('capacity edits in place in the status bar', async () => {
    const box = page.getByLabel('Weekly capacity');
    await box.fill('35');
    await box.press('Enter');
    await settle(page);
    assert.equal((await page.evaluate(() => window.tm.stateFile())).capacity, 35);
    assert.match(await status(page), /^Capacity 35h\/week/);
    await box.fill('');
    await box.blur();
    assert.equal(await box.inputValue(), '35');
    await undo();
    assert.equal((await page.evaluate(() => window.tm.stateFile())).capacity, 40);
  });

  await check('load strip: click a week to override, clear to remove, Esc to leave', async () => {
    const box = await page.locator('.tm-scroller').boundingBox();
    const x = box.x + box.width * 0.6;
    const y = box.y + box.height - 25;
    const before = await loadHash(page);
    await page.mouse.click(x, y);
    const field = page.getByLabel('Hours this week');
    assert.equal(await field.count(), 1);
    await field.fill('90');
    await shoot(page, 'week-edit');
    await field.press('Enter');
    await settle(page);
    assert.equal(await field.count(), 0);
    assert.notEqual(await loadHash(page), before);
    const file = await page.evaluate(() => window.tm.stateFile());
    assert.deepEqual(Object.values(file.weekCapacity), [90]);
    await page.mouse.move(5, 5);
    await shoot(page, 'week-edit-after');
    await page.mouse.click(x, y);
    assert.equal(await field.inputValue(), '90');
    await page.keyboard.press('Escape');
    assert.equal(await field.count(), 0);
    await page.mouse.click(x, y);
    await field.fill('');
    await field.blur();
    await settle(page);
    assert.deepEqual((await page.evaluate(() => window.tm.stateFile())).weekCapacity, {});
    await page.mouse.move(5, 5);
    assert.equal(await loadHash(page), before);
  });

  await check('undo button and Ctrl+Z walk back everything; Ctrl+Z in a field stays in the field', async () => {
    await select('CAN stack port');
    await page.getByLabel('Total hours').fill('33');
    await page.getByLabel('Total hours').press('Enter');
    await settle(page);
    await page.locator('.tm-undo').click();
    await settle(page);
    assert.equal((await note(page, 'gw.fw.drv.can'))['tm-left'], 30);
    await page.getByLabel('Total hours').fill('33');
    await page.getByLabel('Total hours').press('Enter');
    const label = await page.locator('.tm-undo').getAttribute('title');
    await page.getByLabel('Total hours').press('Control+z');
    assert.equal(await page.locator('.tm-undo').getAttribute('title'), label);
    await page.keyboard.press('Escape');
    for (let i = 0; i < 40 && !(await page.locator('.tm-undo').isDisabled()); i++) await undo();
    assert.equal(await page.locator('.tm-undo').isDisabled(), true);
    const fm = await note(page, 'dp.doc');
    assert.equal(fm['tm-left'], 6);
    assert.equal(fm['tm-scope'], 'should');
    assert.equal(fm['tm-deadline'], undefined);
    assert.equal((await note(page, 'gw.fw'))['tm-budget'], undefined);
  });

  await check('dark theme mid-drag', async () => {
    const dark = await open('theme=dark', 'dark', tall);
    const bar = await barPoint(dark, 'rig.sq.rep', true);
    await dark.mouse.move(bar.x, bar.y);
    await dark.mouse.down();
    await dark.mouse.move(bar.x + 70, bar.y, { steps: 8 });
    await shoot(dark, 'drag-dark-mid');
    await dark.mouse.up();
    await dark.close();
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

// To-do rail: real mouse drags, the real store, a fake vault.
{
  const page = await open('theme=light', 'light', { width: 1600, height: 1300 });
  const tab = name => page.locator('.tm-tab', { hasText: name });
  const levels = page.locator('.tm-level');
  const taskRow = title => page.locator('.tm-td', { has: page.locator(`.tm-td-title[title="${title}"]`) });
  const tiers = () => page.evaluate(() => window.tm.store.state.tiers);
  const titles = () => page.evaluate(() => window.tm.store.state.tiers.map(t => t.map(id => window.tm.store.state.items[id].title)));
  const forecast = () => page.evaluate(() => window.tm.forecast());
  const body = id => page.evaluate(i => window.tm.vault.notes.get(window.tm.path(i)).body, id);
  const box = async loc => {
    const b = await loc.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, top: b.y, bottom: b.y + b.height };
  };
  /** Presses on a row and carries it to a point, still held. */
  const carry = async (title, to) => {
    const from = await box(taskRow(title).locator('.tm-td-hd'));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 4, from.y + 6, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.move(to.x, to.y + 1);
  };
  /** Where everything sits, to prove a drag shifts nothing. */
  const layout = () =>
    page.evaluate(() => JSON.stringify([...document.querySelectorAll('.tm-level,.tm-td,.tm-level-head')].map(e => Object.values(e.getBoundingClientRect().toJSON()))));

  await tab('To-do').click();
  await check('to-do tab shows one box per level, overall by default', async () => {
    assert.equal(await levels.count(), (await tiers()).length);
    assert.match(await levels.nth(0).locator('.tm-level-head').textContent(), /Priority 1/);
    const all = (await titles()).flat();
    assert.equal(await page.locator('.tm-td').count(), all.length);
  });
  await check('headers show task count and equal burn', async () => {
    const t = await titles();
    const i = t.findIndex(l => l.length > 1);
    assert.match(await levels.nth(i).locator('.tm-level-head').textContent(), new RegExp(`${t[i].length} tasks, equal burn`));
  });
  await check('rows show open to-dos, hours left and burn', async () => {
    assert.match(await taskRow('CAN transceiver debug').locator('.tm-td-hd').textContent(), /☐\s*\d+\s+[\d.]+h · [\d.]+h\/d/);
  });
  await check('a row expands to its to-dos; a tick writes the note and undoes', async () => {
    const row = taskRow('CAN transceiver debug');
    await row.locator('.tm-td-open').click();
    const box = row.locator('input[type=checkbox]').first();
    await box.waitFor();
    const was = await body('gw.hw.can');
    const label = row.locator('.tm-todos label').first();
    const text = (await label.textContent()).trim();
    const on = await box.isChecked();
    await box.click();
    assert.equal(await box.isChecked(), !on);
    await settle(page);
    assert.notEqual(await body('gw.hw.can'), was);
    assert.match(await body('gw.hw.can'), new RegExp(`\\[${on ? ' ' : 'x'}\\] ${text}`));
    await page.locator('.tm-undo').click();
    await settle(page);
    assert.equal(await body('gw.hw.can'), was);
    assert.equal(await box.isChecked(), on);
  });
  await check('adding a to-do writes the note, shows, and undoes', async () => {
    const row = taskRow('CAN transceiver debug');
    const was = await row.locator('.tm-td-hd .tm-num').textContent();
    const add = row.locator('.tm-todo-add');
    await add.fill('Check bus load');
    await add.press('Enter');
    await row.locator('.tm-todos label', { hasText: 'Check bus load' }).waitFor();
    assert.equal(await add.inputValue(), '');
    assert.notEqual(await row.locator('.tm-td-hd .tm-num').textContent(), was);
    await settle(page);
    assert.match(await body('gw.hw.can'), /- \[ \] Check bus load/);
    await page.locator('.tm-undo').click();
    await settle(page);
    assert.doesNotMatch(await body('gw.hw.can'), /Check bus load/);
    await row.locator('.tm-td-open').click();
  });

  const multi = (await titles()).findIndex(l => l.length > 1);
  await check('drag within a level: neutral, line, banner, no shift, forecast untouched', async () => {
    const t = await titles();
    const [first, second] = t[multi];
    const before = await forecast();
    const hash = await canvasHash(page);
    const still = await layout();
    const target = await box(taskRow(second));
    await carry(first, { x: target.x, y: target.bottom - 3 });
    assert.equal(await page.locator('.tm-lists.tm-dragging').count(), 1);
    const styles = await levels.evaluateAll(els => els.map(e => getComputedStyle(e).borderTopStyle));
    assert.ok(styles.every(s => s === 'dashed'), `borders ${styles}`);
    assert.equal(await levels.nth(multi).evaluate(e => e.classList.contains('tm-level-same')), true);
    assert.equal(await page.locator('.tm-banner').count(), 1);
    assert.equal(await levels.nth(multi).locator('.tm-banner').textContent(), 'Order only: schedule stays the same');
    assert.equal(await page.locator('.tm-insert').count(), 1);
    await shoot(page, 'todo-drag-same-light');
    assert.equal(await layout(), still, 'layout moved during the drag');
    await page.mouse.up();
    await settle(page);
    assert.deepEqual((await titles())[multi].slice(0, 2), [second, first]);
    assert.equal(await page.locator('.tm-banner').count(), 0);
    assert.equal(await page.locator('.tm-lists.tm-dragging').count(), 0);
    assert.equal(await forecast(), before);
    assert.equal(await canvasHash(page), hash);
    assert.equal(await page.locator('.tm-undo').isDisabled(), false);
    await page.locator('.tm-undo').click();
    await settle(page);
    assert.deepEqual((await titles())[multi].slice(0, 2), [first, second]);
  });
  await check('drag to another level: warning, line, banner, no shift, then moved and undoable', async () => {
    const t = await titles();
    const other = multi === 0 ? 1 : 0;
    const moving = t[multi][0];
    const before = await forecast();
    const still = await layout();
    const target = await box(taskRow(t[other][0]));
    await carry(moving, { x: target.x, y: target.top + 3 });
    assert.equal(await levels.nth(other).evaluate(e => e.classList.contains('tm-level-cross')), true);
    assert.equal(await levels.nth(other).locator('.tm-banner').textContent(), `Moves to Priority ${other + 1}: changes who gets hours`);
    assert.equal(await page.locator('.tm-insert').count(), 1);
    const line = await box(page.locator('.tm-insert'));
    assert.ok(Math.abs(line.y - target.top) < 6, `line at ${line.y}, row at ${target.top}`);
    await shoot(page, 'todo-drag-cross-light');
    assert.equal(await layout(), still, 'layout moved during the drag');
    await page.mouse.up();
    await settle(page);
    const moved = await titles();
    assert.equal(moved.length, t.length, 'a drag never creates a level');
    assert.equal(moved[other][0], moving);
    assert.notEqual(await forecast(), before);
    await page.locator('.tm-undo').click();
    await settle(page);
    assert.deepEqual(await titles(), t);
    assert.equal(await forecast(), before);
  });
  await check('dropping outside a level does nothing', async () => {
    const t = await titles();
    const wasUndo = await page.locator('.tm-undo').textContent();
    const head = await box(page.locator('.tm-lists-intro'));
    await carry(t[multi][0], { x: head.x, y: head.y });
    assert.equal(await page.locator('.tm-banner').count(), 0);
    assert.equal(await page.locator('.tm-insert').count(), 0);
    assert.equal(await page.locator('.tm-lists.tm-dragging').count(), 1);
    await page.mouse.up();
    await settle(page);
    assert.equal(await page.locator('.tm-lists.tm-dragging').count(), 0);
    assert.deepEqual(await titles(), t);
    assert.equal(await page.locator('.tm-undo').textContent(), wasUndo);
    // And leaving the rail altogether, after showing a level's banner.
    const target = await box(taskRow(t[multi][1]));
    await carry(t[multi][0], target);
    assert.equal(await page.locator('.tm-banner').count(), 1);
    await page.mouse.move(500, 300, { steps: 6 });
    assert.equal(await page.locator('.tm-banner').count(), 0);
    await page.mouse.up();
    await settle(page);
    assert.deepEqual(await titles(), t);
  });
  await check('levels: + above, + New at the bottom, Remove only on empty ones', async () => {
    const n = (await tiers()).length;
    const before = await forecast();
    assert.equal(await page.locator('.tm-level-remove').count(), 0);
    await levels.nth(0).locator('.tm-level-add').click();
    assert.equal(await levels.count(), n + 1);
    assert.equal((await tiers())[0].length, 0);
    assert.equal(await levels.nth(0).locator('.tm-level-remove').count(), 1);
    assert.match(await levels.nth(0).textContent(), /Empty/);
    await page.locator('.tm-level-bottom').click();
    assert.equal(await levels.count(), n + 2);
    assert.equal((await tiers()).at(-1).length, 0);
    assert.equal(await page.locator('.tm-level-remove').count(), 2);
    assert.equal(await forecast(), before);
    await shoot(page, 'todo-empty-levels-light');
    await levels.nth(n + 1).locator('.tm-level-remove').click();
    await levels.nth(0).locator('.tm-level-remove').click();
    assert.equal(await levels.count(), n);
    await page.locator('.tm-undo').click();
    await page.locator('.tm-undo').click();
    await page.locator('.tm-undo').click();
    await page.locator('.tm-undo').click();
    assert.equal(await levels.count(), n);
    await settle(page);
  });
  await check('dragging into an empty level moves there; the emptied level stays until removed', async () => {
    const t = await titles();
    await levels.nth(0).locator('.tm-level-add').click();
    const target = await box(levels.nth(0).locator('.tm-level-empty'));
    const moving = t[0][0];
    const still = await layout();
    await carry(moving, target);
    assert.equal(await levels.nth(0).locator('.tm-banner').textContent(), 'Moves to Priority 1: changes who gets hours');
    assert.equal(await page.locator('.tm-insert').count(), 1);
    assert.equal(await layout(), still);
    await page.mouse.up();
    await settle(page);
    assert.deepEqual((await titles())[0], [moving]);
    await page.locator('.tm-undo').click();
    await page.locator('.tm-undo').click();
    await settle(page);
    assert.deepEqual(await titles(), t);
  });
  await check('project list follows the focused project', async () => {
    assert.equal(await page.locator('.tm-todo-scope button').nth(1).isDisabled(), true);
    const dp = rowByTitle(page, 'Data Pipeline Migration');
    await dp.hover();
    await dp.locator('.tm-fb').click();
    assert.equal(await page.locator('.tm-tab.tm-on').textContent(), 'To-do');
    const inProject = await page.evaluate(() => {
      const { items, tiers } = window.tm.store.state;
      const root = i => (items[i].parent ? root(items[i].parent) : i);
      return tiers.flat().filter(i => items[root(i)].title === 'Data Pipeline Migration').length;
    });
    assert.ok(inProject > 0);
    assert.equal(await page.locator('.tm-td').count(), inProject);
    assert.equal(await levels.count(), (await tiers()).length);
    await page.locator('.tm-todo-scope button').nth(1).waitFor();
    assert.match(await page.locator('.tm-todo-scope button').nth(1).textContent(), /Data Pipeline Migration/);
    await shoot(page, 'todo-project-light');
    await page.locator('.tm-todo-scope button').nth(0).click();
    assert.equal(await page.locator('.tm-td').count(), (await tiers()).flat().length);
    await page.locator('.tm-todo-scope button').nth(1).click();
    await page.locator('.tm-up').click();
    assert.equal(await page.locator('.tm-td').count(), (await tiers()).flat().length);
  });
  await check('level ids with no item yet are tolerated', async () => {
    const n = await page.locator('.tm-td').count();
    await page.evaluate(() => window.tm.store.state.tiers.push(['Projects/not indexed yet.md']));
    await page.locator('.tm-tab', { hasText: 'Overview' }).click();
    await tab('To-do').click();
    assert.equal(await page.locator('.tm-td').count(), n);
    assert.match(await levels.last().textContent(), /Empty/);
    assert.equal(await levels.last().locator('.tm-level-remove').count(), 0);
    await page.evaluate(() => window.tm.store.state.tiers.pop());
    await page.locator('.tm-tab', { hasText: 'Overview' }).click();
    await tab('To-do').click();
  });
  await check('clicking a row title opens its details', async () => {
    await taskRow('CAN transceiver debug').locator('.tm-td-title').click();
    assert.equal(await railTitle(page), 'CAN transceiver debug');
    assert.equal(await page.locator('.tm-tab.tm-on').textContent(), 'Details');
  });
  await check('task details: priority dropdown lists existing levels and moves the task', async () => {
    const pick = page.locator('.tm-rail select[aria-label="Priority"]');
    const t = await titles();
    assert.deepEqual(await pick.locator('option').allTextContents(), t.map((_, i) => `Priority ${i + 1}`));
    const from = t.findIndex(l => l.includes('CAN transceiver debug'));
    const to = from === 0 ? 1 : 0;
    assert.equal(await pick.inputValue(), String(from));
    const before = await forecast();
    await pick.selectOption(String(to));
    assert.ok((await titles())[to].includes('CAN transceiver debug'));
    assert.equal(await pick.inputValue(), String(to));
    assert.notEqual(await forecast(), before);
    await page.locator('.tm-undo').click();
    await settle(page);
  });
  await check('task details: to-dos tick and add', async () => {
    const list = page.locator('.tm-rail .tm-todos');
    const box = list.locator('input[type=checkbox]').last();
    const was = await box.isChecked();
    const note = await body('gw.hw.can');
    await box.click();
    assert.equal(await box.isChecked(), !was);
    await settle(page);
    assert.notEqual(await body('gw.hw.can'), note);
    await page.locator('.tm-undo').click();
    await settle(page);
    const add = page.locator('.tm-rail .tm-todo-add');
    await add.fill('From details');
    await add.press('Enter');
    await list.locator('label', { hasText: 'From details' }).waitFor();
    await settle(page);
    assert.match(await body('gw.hw.can'), /- \[ \] From details/);
    await page.locator('.tm-undo').click();
    await settle(page);
    await page.keyboard.press('Escape');
  });
  await check('parent overview: to-dos tick', async () => {
    await page.locator('.tm-rail').click({ position: { x: 5, y: 5 } });
    await page.evaluate(() => window.tm.store.addTodo(window.tm.path('gw.fw'), 'Review boot flow'));
    await settle(page);
    await page.locator('.tm-tab', { hasText: 'Overview' }).click();
    await rowByTitle(page, 'Firmware').locator('.tm-t').click();
    const box = page.locator('.tm-rail .tm-todos input[type=checkbox]');
    await box.waitFor();
    await box.click();
    await settle(page);
    assert.match(await body('gw.fw'), /- \[x\] Review boot flow/);
    await page.keyboard.press('Escape');
  });
  await page.close();
}

// Screenshots
for (const theme of ['light', 'dark']) {
  await check(`screenshots ${theme}`, async () => {
    const page = await open(`theme=${theme}`, theme);
    await shoot(page, `top-${theme}`);
    await rowByTitle(page, 'CAN transceiver debug').locator('.tm-t').click();
    await shoot(page, `task-${theme}`);
    await page.locator('.tm-tab', { hasText: 'To-do' }).click();
    await page.locator('.tm-td-open').first().click();
    await page.locator('.tm-td .tm-todos').waitFor();
    const moving = await page.locator('.tm-td-hd').first().boundingBox();
    const into = await page.locator('.tm-level').nth(1).locator('.tm-td-hd').nth(1).boundingBox();
    await page.mouse.move(moving.x + 60, moving.y + 8);
    await page.mouse.down();
    await page.mouse.move(into.x + 60, into.y + 16, { steps: 10 });
    await page.mouse.move(into.x + 60, into.y + 15);
    await shoot(page, `todo-drag-${theme}`);
    await page.mouse.move(800, 300, { steps: 4 });
    await page.mouse.up();
    await page.locator('.tm-tab', { hasText: 'Details' }).click();
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
