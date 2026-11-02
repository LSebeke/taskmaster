/**
 * `npm run smoke`: the built plugin in the real Obsidian, on a throwaway vault and config under the OS
 * temp dir. Drives it over CDP, checks notes on disk, and fails on any page error. Screenshots, dark and
 * light: dev/.out/smoke (or SMOKE_SHOTS). Set SMOKE_KEEP=1 to keep the temp dir.
 * It never reads or writes ~/.config/obsidian, and only ever signals the process group it started.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { smokeSteps } from './smoke-steps.mjs';

const dev = dirname(fileURLToPath(import.meta.url));
const repo = dirname(dev);
const OBSIDIAN = '/usr/bin/obsidian';
const shots = resolve(process.env.SMOKE_SHOTS ?? join(dev, '.out/smoke'));
const VIEWPORT = { width: 1600, height: 900 };
/** Longer than the plugin's write and debounce windows together. */
const SETTLE_MS = 900;
const only = process.env.SMOKE_ONLY?.split(',');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** `n` calendar days from today. */
const inDays = n => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoDay(d);
};
const TODAY = isoDay(new Date());

// --- The throwaway world ---

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'taskmaster-smoke-')));
const vaultDir = join(temp, 'vault');
const cfg = join(temp, 'cfg');
const userData = join(cfg, 'obsidian');
const home = join(temp, 'home');

/** A second lock on the door: nothing here may lead to the real config. */
function assertThrowaway(path) {
  const inside = relative(temp, path);
  assert(inside && !inside.startsWith('..') && !inside.startsWith(sep), `${path} is outside the temp dir`);
  assert(!path.startsWith(join(homedir(), '.config')), `${path} is in the real config`);
}
for (const p of [vaultDir, cfg, userData, home]) assertThrowaway(p);

const note = (rel, fm, body = '') => {
  const path = join(vaultDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  writeFileSync(path, `---\n${lines.join('\n')}\n---\n${body}`);
};

function seedVault() {
  mkdirSync(join(vaultDir, '.obsidian/plugins/taskmaster'), { recursive: true });
  mkdirSync(userData, { recursive: true });
  mkdirSync(home, { recursive: true });
  // Alpha is a parent, so it lives in a folder of its own, as those the plugin makes do.
  note('Projects/Alpha/Alpha.md', { 'tm-type': 'item', 'tm-deadline': inDays(60) }, 'Project note.\n');
  note('Projects/Alpha/Design.md', { 'tm-type': 'item', 'tm-parent': '[[Alpha]]', 'tm-estimate': 12, 'tm-left': 12 }, '- [ ] First to-do\n- [ ] Second to-do\n');
  note('Projects/Alpha/Assembly.md', { 'tm-type': 'item', 'tm-parent': '[[Alpha]]', 'tm-deps': ['[[Design]]'], 'tm-estimate': 20, 'tm-left': 20 });
  note('Projects/Alpha/Test run.md', { 'tm-type': 'item', 'tm-parent': '[[Alpha]]', 'tm-deps': ['[[Assembly]]'], 'tm-estimate': 6, 'tm-left': 6 });
  note('Projects/Beta.md', { 'tm-type': 'item', 'tm-estimate': 16, 'tm-left': 16 });
  note('Projects/Gamma.md', { 'tm-type': 'item', 'tm-estimate': 24, 'tm-left': 24 });
  mkdirSync(join(vaultDir, '_taskmaster'), { recursive: true });
  writeFileSync(join(vaultDir, '.obsidian/community-plugins.json'), '["taskmaster"]');
  writeFileSync(join(vaultDir, '.obsidian/app.json'), '{}');
  const id = 'taskmastersmoke1';
  writeFileSync(join(userData, 'obsidian.json'), JSON.stringify({ vaults: { [id]: { path: vaultDir, ts: Date.now(), open: true } } }));
}

const setTheme = theme => writeFileSync(join(vaultDir, '.obsidian/appearance.json'), JSON.stringify({ theme: theme === 'dark' ? 'obsidian' : 'moonstone' }));

function installPlugin() {
  for (const f of ['main.js', 'manifest.json', 'styles.css']) cpSync(join(repo, f), join(vaultDir, '.obsidian/plugins/taskmaster', f));
}

// --- Obsidian, which this script starts and stops ---

const freePort = () =>
  new Promise((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

let child = null;
let browser = null;
let page = null;
const problems = [];

async function launch() {
  const port = await freePort();
  const args = [`--user-data-dir=${userData}`, '--no-sandbox', '--ozone-platform=headless', `--remote-debugging-port=${port}`, '--disable-gpu'];
  const env = { ...process.env, XDG_CONFIG_HOME: cfg, HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  // Its own process group, so the stop reaches the helpers Electron forks and nothing else.
  child = spawn(OBSIDIAN, args, { env, detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  const started = child;
  started.once('exit', () => {
    if (child === started) child = null;
  });
  for (let i = 0; ; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch (e) {
      if (i > 120) throw e;
      await sleep(250);
    }
  }
  for (let i = 0; !page; i++) {
    page = browser.contexts()[0]?.pages().find(p => p.url().includes('index.html')) ?? null;
    if (i > 120) throw new Error('Obsidian never opened a window');
    if (!page) await sleep(250);
  }
  page.setDefaultTimeout(6000);
  page.on('pageerror', e => problems.push(`page: ${e.stack ?? e.message}`));
  page.on('console', m => m.type() === 'error' && !benign(m.text()) && problems.push(`console: ${m.text()}`));
  await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 30_000 });
  await page.setViewportSize(VIEWPORT);
  await sleep(300);
  const trust = page.getByRole('button', { name: 'Trust author and enable plugins' });
  if (await trust.isVisible()) {
    await trust.click();
    await page.keyboard.press('Escape');
  }
}

/** Obsidian's own chatter in a sandbox with no network or GPU, none of it ours. */
const benign = text => /net::ERR|Failed to load resource|WebGL|GPU|Autofill/.test(text);

async function quit() {
  const running = child;
  const gone = running ? new Promise(r => running.once('exit', r)) : null;
  // Closing the window is what makes Electron write its storage out, trust in the plugins included.
  await page?.evaluate(() => void window.close()).catch(() => undefined);
  if (gone) await Promise.race([gone, sleep(5000)]);
  await browser?.close().catch(() => undefined);
  browser = null;
  page = null;
  if (!running || child !== running) return;
  const group = sig => {
    try {
      process.kill(-running.pid, sig);
    } catch {
      /* Already gone. */
    }
  };
  group('SIGTERM');
  await Promise.race([gone, sleep(4000)]);
  group('SIGKILL');
  await Promise.race([gone, sleep(2000)]);
  child = null;
}

// --- What the checks read and do ---

const vaultPath = rel => join(vaultDir, rel);
const read = rel => readFileSync(vaultPath(rel), 'utf8');
const has = rel => existsSync(vaultPath(rel));
/** Every note under Projects, relative to the vault. */
const notes = (dir = 'Projects') => readdirSync(vaultPath(dir), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? notes(`${dir}/${e.name}`) : e.name.endsWith('.md') ? [`${dir}/${e.name}`] : []));
const state = () => JSON.parse(read('_taskmaster/state.json'));

const settle = () => sleep(SETTLE_MS);
const row = title => page.locator('.tm-row', { has: page.locator(`.tm-t[title="${title}"]`) }).first();
const rail = () => page.locator('.tm-rail');
const status = () => page.locator('.tm-changes').textContent();
const rowTitles = () => page.locator('.tm-row .tm-t').evaluateAll(els => els.map(e => e.getAttribute('title')));
const command = id => page.evaluate(c => window.app.commands.executeCommandById(c), id);
const select = title => row(title).locator('.tm-t').click();
const clearUi = async () => {
  for (let i = 0; i < 6; i++) await page.keyboard.press('Escape');
};
const reloadPlugin = () =>
  page.evaluate(async () => {
    await app.plugins.disablePlugin('taskmaster');
    await app.plugins.enablePlugin('taskmaster');
  });
const shotPath = name => {
  mkdirSync(shots, { recursive: true });
  return join(shots, `${name}.png`);
};
const shoot = name => page.screenshot({ path: shotPath(name) });
const barPoint = (title, fc = true) =>
  page.evaluate(
    ([t, f]) => {
      const g = app.workspace.getLeavesOfType('taskmaster')[0].view.gantt;
      const id = Object.keys(app.plugins.plugins.taskmaster.store.state.items).find(k => k.endsWith(`/${t}.md`));
      return g.barRect(id, f);
    },
    [title, fc],
  );

const dragRow = async (title, target, zone) => {
  const from = await row(title).boundingBox();
  const to = await row(target).boundingBox();
  const y = { before: to.y + 3, after: to.y + to.height - 3, in: to.y + to.height / 2 }[zone];
  await page.mouse.move(from.x + 120, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 120, y, { steps: 8 });
  await sleep(150);
  await page.mouse.up();
};

const addVia = async (title, inside, fill = async () => {}) => {
  await clearUi();
  await page.locator('.tm-top button', { hasText: '+ Item' }).click();
  const f = rail().locator('form');
  await f.getByLabel('Name').fill(title);
  if (inside) {
    const value = await f.getByLabel('Inside').locator('option', { hasText: inside }).first().getAttribute('value');
    await f.getByLabel('Inside').selectOption(value);
  }
  await fill(f);
  await f.getByLabel('Name').press('Enter');
  await settle();
  await clearUi();
};

/** Bars have colour: each project hue is on the canvas, not just grey. */
const canvasColours = () =>
  page.evaluate(() => {
    const c = document.querySelector('.tm-canvas');
    const { data } = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
    const seen = {};
    for (let i = 0; i < data.length; i += 4 * 3) {
      if (data[i + 3] !== 255) continue;
      const k = `${data[i] & 0xf0},${data[i + 1] & 0xf0},${data[i + 2] & 0xf0}`;
      seen[k] = (seen[k] ?? 0) + 1;
    }
    // The real hues, resolved from the stylesheet as a person would see them.
    const probe = document.createElement('span');
    document.querySelector('.tm-root').append(probe);
    const hue = n => {
      probe.style.color = `var(--tm-c${n})`;
      const m = /(\d+)[, ]+(\d+)[, ]+(\d+)/.exec(getComputedStyle(probe).color);
      return m ? m.slice(1, 4).map(x => Number(x) & 0xf0).join(',') : '';
    };
    const hues = [hue(1), hue(2), hue(3)];
    const surface = (probe.style.color = 'var(--tm-surface)', getComputedStyle(probe).color);
    probe.remove();
    const [r, g, b] = /(\d+)[, ]+(\d+)[, ]+(\d+)/.exec(surface).slice(1, 4).map(Number);
    return { hues, found: hues.map(h => seen[h] ?? 0), corner: [...data.slice(0, 3)], surface: [r, g, b], cssVarSet: !!hues[0] };
  });

async function assertColours() {
  await page.waitForFunction(() => !!document.querySelector('.tm-canvas'));
  await sleep(200);
  const c = await canvasColours();
  assert(c.cssVarSet, `stylesheet not applied: ${JSON.stringify(c)}`);
  assert(c.found.filter(n => n > 50).length >= 3, `project colours missing from the canvas: ${JSON.stringify(c)}`);
  const near = c.corner.every((v, i) => Math.abs(v - c.surface[i]) < 24);
  assert(near, `canvas background is not the surface colour: ${JSON.stringify(c)}`);
}

// --- Run ---

const world = { sleep, inDays, TODAY, read, has, notes, state, settle, row, rail, status, rowTitles, command, select, clearUi, reloadPlugin, shoot, shotPath, barPoint, dragRow, addVia, assertColours, setTheme, launch, quit, vaultPath, get page() { return page; }, problems };

const steps = [];
const step = (name, fn) => steps.push({ name, fn });

step('load: plugin enables, no warnings, rows show', async () => {
  await page.evaluate(async () => {
    await app.plugins.setEnable(true);
    await app.plugins.enablePlugin('taskmaster');
  });
  assert(await page.evaluate(() => !!app.plugins.plugins.taskmaster));
  assert((await page.evaluate(() => Object.keys(app.commands.commands).filter(c => c.startsWith('taskmaster:')))).length > 3);
});

step('open: the view lists every item', async () => {
  await command('taskmaster:open');
  await row('Design').waitFor();
  const t = await rowTitles();
  for (const x of ['Alpha', 'Design', 'Assembly', 'Test run', 'Beta', 'Gamma']) assert(t.includes(x), `${x} missing from ${t}`);
  await assertColours();
  await shoot('01-open-light');
});


for (const [name, fn] of smokeSteps(world)) step(name, fn);

async function main() {
  execFileSync('npm', ['run', 'build', '--silent'], { cwd: repo, stdio: 'inherit' });
  seedVault();
  setTheme('light');
  installPlugin();
  await launch();
  let failed = 0;
  for (const { name, fn } of steps) {
    if (only && !only.some(o => name.includes(o)) && !name.startsWith('load') && !name.startsWith('open')) continue;
    const before = problems.length;
    try {
      await fn();
      assert.equal(problems.length, before, problems.slice(before).join('\n'));
      console.log(`ok   ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}\n${String(e.stack ?? e).slice(0, 1800)}`);
      if (page) await shoot(`fail-${failed}`).catch(() => undefined);
    }
  }
  console.log(`\n${steps.length - failed}/${steps.length} steps, ${problems.length} page errors, shots in ${shots}`);
  return failed || problems.length ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(e);
} finally {
  await quit();
  if (process.env.SMOKE_KEEP) console.log(`kept ${temp}`);
  else rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(code);
