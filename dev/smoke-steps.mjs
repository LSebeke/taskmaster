/** The steps of `npm run smoke`, in order. Each builds on what the last left in the vault. */
import assert from 'node:assert/strict';

const yes = (text, re, what) => assert.match(text, re, what);

export function smokeSteps(w) {
  const rail = () => w.rail();
  const button = name => rail().getByRole('button', { name, exact: true });
  const store = (fn, arg) => w.page.evaluate(`(${fn})(app.plugins.plugins.taskmaster.store, ${JSON.stringify(arg ?? null)})`);
  const label = text => rail().getByLabel(text, { exact: true });
  const noGuard = async () => assert.equal(await w.page.locator('.tm-guard').count(), 0, 'a part of the view failed to draw');
  const restart = async () => {
    await w.page.evaluate(() => app.workspace.requestSaveLayout?.run?.());
    await w.sleep(2500);
    await w.quit();
    await w.launch();
  };

  return [
    [
      'restart with the view open: restored, coloured, light and dark',
      async () => {
        await restart();
        await w.row('Design').waitFor();
        await w.assertColours();
        await w.shoot('02-restart-light');
        w.setTheme('dark');
        await restart();
        await w.row('Design').waitFor();
        await w.assertColours();
        await w.shoot('03-restart-dark');
      },
    ],
    [
      'log: hours reach the note',
      async () => {
        await w.select('Design');
        await label('Hours to log').fill('3');
        await button('Log').click();
        await w.settle();
        const n = w.read('Projects/Alpha/Design.md');
        yes(n, /tm-left: 9/);
        yes(n, new RegExp(`${w.TODAY} 3`));
        await w.clearUi();
      },
    ],
    [
      'to-do tick: the checkbox in the note changes',
      async () => {
        await w.select('Design');
        await rail().locator('.tm-todos input[type=checkbox]').first().check();
        await w.settle();
        const n = w.read('Projects/Alpha/Design.md');
        yes(n, /- \[x\] First to-do/);
        yes(n, /- \[ \] Second to-do/);
        await w.clearUi();
      },
    ],
    [
      'create: a note with frontmatter, in the parent',
      async () => {
        await w.addVia('Widget', 'Alpha', f => f.getByLabel('Hours').fill('5'));
        const n = w.read('Projects/Alpha/Widget.md');
        yes(n, /tm-type: "?item/);
        yes(n, /tm-parent: "\[\[Alpha\]\]"/);
        yes(n, /tm-left: 5/);
      },
    ],
    [
      'rename: the note follows',
      async () => {
        await w.select('Widget');
        await label('Name').fill('Gadget');
        await label('Name').press('Enter');
        await w.settle();
        assert(w.has('Projects/Alpha/Gadget.md'), String(w.notes()));
        assert(!w.has('Projects/Alpha/Widget.md'));
        await w.clearUi();
      },
    ],
    [
      'gain a child: the note moves into its folder, hours become a budget',
      async () => {
        await w.addVia('Sub', 'Test run', f => f.getByLabel('Hours').fill('2'));
        assert(w.has('Projects/Alpha/Test run/Test run.md'), String(w.notes()));
        assert(w.has('Projects/Alpha/Test run/Sub.md'), String(w.notes()));
        yes(w.read('Projects/Alpha/Test run/Test run.md'), /tm-budget: 6/);
        yes(w.read('Projects/Alpha/Test run/Sub.md'), /tm-parent: "?\[\[Test run/);
      },
    ],
    [
      'row drag across folders: the crash repro, with a panel open on another item',
      async () => {
        await w.select('Alpha');
        await w.dragRow('Design', 'Alpha', 'after');
        await w.settle();
        await noGuard();
        assert(w.has('Projects/Design.md'), String(w.notes()));
        assert.equal(await rail().locator('h2').first().textContent(), 'Alpha');
        assert(await rail().getByLabel('Inside').locator('option', { hasText: 'Test run' }).count());
        await w.select('Beta');
        await w.dragRow('Gadget', 'Beta', 'in');
        await w.settle();
        assert(w.has('Projects/Beta/Beta.md') && w.has('Projects/Beta/Gadget.md'), String(w.notes()));
        yes(w.read('Projects/Beta/Beta.md'), /tm-budget: 16/);
        await w.page.mouse.move(5, 5);
        await w.clearUi();
      },
    ],
    [
      'bar drag: a pin lands in the note',
      async () => {
        await w.clearUi();
        const bar = await w.barPoint('Gamma');
        assert(bar, 'Gamma has no bar');
        await w.page.mouse.move(bar.x, bar.y);
        await w.page.mouse.down();
        await w.page.mouse.move(bar.x + 14 * 7, bar.y, { steps: 10 });
        await w.page.mouse.up();
        await w.settle();
        yes(w.read('Projects/Gamma.md'), /tm-pin-start: /);
        await w.page.mouse.move(5, 5);
      },
    ],
    [
      'to-do tab: drag a task to another priority level',
      async () => {
        await w.clearUi();
        await rail().locator('.tm-tab', { hasText: 'To-do' }).click();
        await rail().locator('.tm-level-bottom').click();
        await w.sleep(150);
        const levels = rail().locator('.tm-level');
        assert.equal(await levels.count(), 2);
        const from = await rail().locator('.tm-td-hd', { hasText: 'Gamma' }).boundingBox();
        const to = await levels.nth(1).boundingBox();
        await w.page.mouse.move(from.x + 60, from.y + from.height / 2);
        await w.page.mouse.down();
        await w.page.mouse.move(from.x + 62, from.y + 20, { steps: 3 });
        await w.page.mouse.move(to.x + 60, to.y + to.height - 8, { steps: 8 });
        await w.sleep(150);
        await w.shoot('04-todo-drag');
        await w.page.mouse.up();
        await w.settle();
        assert.deepEqual(w.state().tiers[1], ['Projects/Gamma.md']);
        assert(!w.state().tiers[0].includes('Projects/Gamma.md'));
        await rail().locator('.tm-tab', { hasText: /Overview|Details/ }).click();
      },
    ],
    [
      'external: create it, link work, see its effect',
      async () => {
        await w.clearUi();
        await w.page.locator('.tm-top button', { hasText: '+ Item' }).click();
        const f = rail().locator('form');
        await f.getByRole('button', { name: 'External', exact: true }).click();
        await f.getByLabel('Name').fill('Maintenance');
        await f.getByLabel('Start').fill(w.inDays(1));
        await f.getByLabel('End').fill(w.inDays(30));
        await f.getByLabel('Name').press('Enter');
        await w.settle();
        await w.clearUi();
        const n = w.read('Projects/_external/Maintenance.md');
        yes(n, /tm-type: "?external/);
        yes(n, new RegExp(`tm-pin-end: "?${w.inDays(30)}`));
        await w.select('Maintenance');
        const value = await rail().getByLabel('Add blocked item').locator('option', { hasText: 'Assembly' }).first().getAttribute('value');
        await rail().getByLabel('Add blocked item').selectOption(value);
        await w.settle();
        yes(await rail().locator('.tm-effect').textContent(), /starts \d+d later/);
        yes(w.read('Projects/Alpha/Assembly.md'), /Maintenance/);
        await w.shoot('05-external');
        await w.clearUi();
      },
    ],
    [
      'Update plan: state.json takes the forecast',
      async () => {
        await w.clearUi();
        await w.page.locator('.tm-plan-btn').click();
        await w.page.locator('.tm-dialog').waitFor();
        await w.shoot('06-plan-dialog');
        await w.page.locator('.tm-dialog button.tm-primary').click();
        await w.settle();
        const { plan } = w.state();
        assert(plan['Projects/Beta/Gadget.md'], Object.keys(plan).join());
        assert(plan['Projects/Design.md']);
        yes(plan['Projects/Design.md'].end, /^\d{4}-\d\d-\d\d$/);
      },
    ],
    [
      'settings tab: renders, and a change lands in state.json',
      async () => {
        // Obsidian opens settings in a window of its own.
        await w.page.evaluate(() => {
          app.setting.open();
          void app.setting.openTabById('taskmaster');
        });
        let win = null;
        for (let i = 0; !win && i < 40; i++) {
          win = w.page.context().pages().find(p => p !== w.page) ?? null;
          await w.sleep(100);
        }
        assert(win, 'the settings window never opened');
        await win.setViewportSize({ width: 1000, height: 800 });
        const tab = win.locator('.vertical-tab-content', { hasText: 'Weekly capacity' });
        await tab.waitFor();
        await w.sleep(300);
        await win.screenshot({ path: w.shotPath('07-settings') });
        for (const t of ['Stale after', 'Projects folder', 'Week overrides', 'Holidays']) assert(await tab.getByText(t).first().isVisible(), t);
        const field = tab.locator('.setting-item', { hasText: 'Weekly capacity' }).locator('input');
        await field.fill('35');
        await field.press('Tab');
        await w.settle();
        assert.equal(w.state().capacity, 35);
        await w.page.evaluate(() => void app.setting.close());
        await w.sleep(300);
      },
    ],
    [
      'timer: stop asks for hours left, both reach the note',
      async () => {
        await w.select('Gamma');
        await button('Start timer').click();
        await w.settle();
        assert.equal(w.state().timer.id, 'Projects/Gamma.md');
        await w.shoot('08-timer');
        const bars = await w.page.evaluate(() => [...document.querySelectorAll('.status-bar .plugin-taskmaster')].map(e => e.textContent));
        assert.deepEqual(bars.filter(Boolean), [], 'the timer shows twice');
        assert.equal(await w.page.locator('.tm-timer').count(), 1);
        // An hour on the clock, without waiting one.
        await store(s => {
          const now = s.now;
          s.now = () => now() + 3_600_000;
        });
        await button('Stop timer').click();
        const modal = w.page.locator('.modal-container .tm-prompt');
        await modal.waitFor();
        await w.shoot('09-hours-left');
        await modal.locator('input').fill('20');
        await modal.locator('button.mod-cta').click();
        await w.settle();
        const n = w.read('Projects/Gamma.md');
        yes(n, /tm-left: 20/);
        yes(n, new RegExp(`${w.TODAY} 1`));
        assert.equal(w.state().timer, undefined);
        await w.clearUi();
      },
    ],
    [
      'plugin reload keeps state',
      async () => {
        const before = w.state();
        await w.reloadPlugin();
        await w.sleep(800);
        await w.command('taskmaster:open');
        await w.row('Gamma').waitFor();
        const t = await w.rowTitles();
        for (const x of ['Alpha', 'Design', 'Gadget', 'Maintenance']) assert(t.includes(x), `${x} missing from ${t}`);
        await w.settle();
        assert.deepEqual(w.state(), before);
        await w.assertColours();
      },
    ],
    [
      'nothing is clipped: status bar, legend, column foot',
      async () => {
        const cap = await w.page.locator('.tm-cap').boundingBox();
        const bar = await w.page.locator('.status-bar').boundingBox();
        assert(cap.x + cap.width <= bar.x, `capacity ends at ${cap.x + cap.width}, Obsidian's status bar starts at ${bar.x}`);
        const legend = await w.page.locator('.tm-legend').boundingBox();
        assert(legend.height <= 44, `legend ${legend.height}px tall`);
        const foot = await w.page.locator('.tm-tree-foot').evaluate(e => [e.scrollHeight, e.clientHeight]);
        assert(foot[0] <= foot[1], `foot ${foot}`);
      },
    ],
    [
      'the timer goes to Obsidian\'s bar once the view is away',
      async () => {
        await w.select('Gamma');
        await button('Start timer').click();
        await w.sleep(200);
        await w.page.evaluate(() => app.workspace.getLeaf('tab').setViewState({ type: 'empty', active: true }));
        await w.sleep(400);
        const shown = await w.page.evaluate(() => [...document.querySelectorAll('.status-bar .plugin-taskmaster')].map(e => e.textContent).join(''));
        yes(shown, /Gamma/);
        await w.command('taskmaster:toggle-timer');
        await w.command('taskmaster:open');
        await w.settle();
        assert.equal(w.state().timer, undefined);
      },
    ],
    [
      'final look, light and dark',
      async () => {
        await w.select('Alpha');
        await w.page.mouse.move(5, 5);
        await w.page.evaluate(() => app.changeTheme?.('obsidian'));
        await w.sleep(400);
        await w.assertColours();
        await w.shoot('20-final-dark');
        await w.page.evaluate(() => app.changeTheme?.('moonstone'));
        await w.sleep(400);
        await w.assertColours();
        await w.shoot('21-final-light');
        await noGuard();
      },
    ],
  ];
}
