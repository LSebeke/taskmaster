/** MVP signal, estimates, next-up, stale, external effect, timer, backlinks, settings and commands, on the real store. */
import assert from 'node:assert/strict';

const tall = { width: 1600, height: 1300 };

export async function signalChecks({ open, shoot, check, rowByTitle, railTitle, status, settle, barPoint }) {
  const select = (page, title) => rowByTitle(page, title).locator('.tm-t').click();
  const rail = page => page.locator('.tm-rail');
  const card = page => page.locator('.tm-mvp');
  const runs = page => page.evaluate(() => window.tm.view.gantt.signals.runs);
  const idOf = (page, title) => page.evaluate(t => Object.keys(window.tm.store.state.items).find(k => window.tm.store.state.items[k].title === t), title);
  const item = (page, title) => page.evaluate(t => Object.values(window.tm.store.state.items).find(i => i.title === t) ?? null, title);
  const setDeadline = (page, title, day) =>
    page.evaluate(
      ([t, d]) => {
        const id = Object.keys(window.tm.store.state.items).find(k => window.tm.store.state.items[k].title === t);
        window.tm.store.apply(window.tm.edits.setDeadline(id, d));
      },
      [title, day],
    );
  const dayOf = iso => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
  const run = (page, id) => page.evaluate(i => window.tm.command(i), id);
  const modal = page => page.locator('.tm-fake-dialog');
  const settings = page => page.locator('.tm-fake-settings');
  const row = (page, name) => settings(page).locator('.setting-item', { hasText: name });

  // Worked by hand. 30h/week is 6h/day from Mon 2 Nov. Levels [Blocked task], [Must, Should, Could], 12h each.
  // The outage holds Blocked task to Wed 4 Nov. Project Alpha has 5 worked days to Fri 6 Nov.
  // Full: 36h + 6h is 7 days, Tue 10 Nov. No could-haves: 24h + 6h is 5 days, Fri 6 Nov. Must only: 12h on Mon and Tue, Tue 3 Nov.
  // Done one ran 15h on 10h, so 1.5. Adjusted: 54h + 6h is 10 days, Fri 13 Nov.
  {
    const page = await open('mini&theme=light', 'light', tall);
    await check('nothing reruns until a panel with a signal is on screen', async () => {
      assert.equal(await railTitle(page), 'All projects');
      assert.equal(await runs(page), 0);
    });
    await check('MVP signal: three finishes, hours saved, deadline, verdict', async () => {
      await select(page, 'Alpha');
      const text = (await card(page).innerText()).replace(/\s+/g, ' ');
      assert.match(text, /▲ Drop could-haves/);
      assert.match(text, /Full scope 10 Nov ▲/);
      assert.match(text, /No could-haves \(−12h\) 6 Nov ✓/);
      assert.match(text, /Must-haves only \(−24h\) 3 Nov ✓/);
      assert.match(text, /Deadline 6 Nov/);
    });
    await check('estimate accuracy and adjusted finish', async () => {
      assert.match((await page.locator('.tm-estimate').innerText()).replace(/\s+/g, ' '), /1\.5× estimate\. Adjusted finish: 13 Nov/);
    });
    await check('selecting away and back, and scrolling, rerun nothing', async () => {
      const before = await runs(page);
      assert.equal(before, 2);
      await select(page, 'Must one');
      await select(page, 'Alpha');
      await page.locator('.tm-scroller').evaluate(e => (e.scrollLeft += 200));
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await runs(page), before);
    });
    await check('a task panel runs nothing, an edit reruns only what is on screen', async () => {
      await select(page, 'Must one');
      const before = await runs(page);
      await page.evaluate(() => window.tm.store.apply(window.tm.edits.setDeadline(Object.keys(window.tm.store.state.items).find(k => window.tm.store.state.items[k].title === 'Alpha'), null)));
      assert.equal(await runs(page), before);
      await setDeadline(page, 'Alpha', dayOf('2026-11-06'));
    });
    await check('a live drag keeps the shown signal and runs nothing', async () => {
      await select(page, 'Alpha');
      const before = await runs(page);
      const text = await card(page).innerText();
      const top = await card(page).boundingBox();
      const bar = await barPoint(page, 'mini.c', true);
      await page.mouse.move(bar.x, bar.y);
      await page.mouse.down();
      await page.mouse.move(bar.x + 60, bar.y, { steps: 5 });
      assert.equal(await runs(page), before);
      assert.equal(await card(page).innerText(), text);
      assert.deepEqual(await card(page).boundingBox(), top);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await page.mouse.move(5, 5);
    });
    await check('the four verdicts', async () => {
      await select(page, 'Alpha');
      await setDeadline(page, 'Alpha', dayOf('2026-11-10'));
      assert.match(await card(page).innerText(), /✓ Full scope makes it/);
      await shoot(page, 'mvp-full');
      await setDeadline(page, 'Alpha', dayOf('2026-11-03'));
      assert.match(await card(page).innerText(), /▲ MVP mode: must-haves only/);
      await setDeadline(page, 'Alpha', dayOf('2026-11-02'));
      assert.match(await card(page).innerText(), /▲ Even must-haves miss: change the plan/);
      await setDeadline(page, 'Alpha', dayOf('2026-11-06'));
    });
    await check('a project with no deadline gets no MVP signal', async () => {
      await setDeadline(page, 'Alpha', null);
      assert.equal(await card(page).count(), 0);
      await setDeadline(page, 'Alpha', dayOf('2026-11-06'));
    });
    await check('external effect: start shift per blocked item, project finish shift', async () => {
      await select(page, 'Bench outage');
      const text = (await page.locator('.tm-effect').innerText()).replace(/\s+/g, ' ');
      assert.match(text, /Blocked task ▲ starts 2d later/);
      assert.match(text, /Beta finish ▲ 2d later/);
    });
    await check('rail order on a project: MVP, estimate, notes, properties, then the lists', async () => {
      await select(page, 'Alpha');
      const heads = await rail(page).locator('h3').allTextContents();
      const at = t => heads.indexOf(t);
      assert.ok(at('Will I make it?') >= 0 && at('Will I make it?') < at('Your estimates'), heads.join());
      assert.ok(at('Your estimates') < at('Linked notes'), heads.join());
      assert.ok(at('Properties') < at('Next up'), heads.join());
    });
    await check('upcoming external items and next-up on the top level', async () => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      assert.equal(await railTitle(page), 'All projects');
      const heads = await rail(page).locator('h3').allTextContents();
      assert.ok(heads.indexOf('External') < heads.indexOf('Next up'), heads.join());
      const next = (await page.locator('.tm-next .tm-li').allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
      // Blocked task waits for the outage, which leaves the three tied tasks.
      assert.equal(next.length, 3);
      assert.ok(next.every(t => /one/.test(t) && /12h$/.test(t)), next.join());
    });
    await page.close();
  }

  {
    const page = await open('theme=light', 'light', tall);
    await check('next-up: five at most, higher levels first, and the row selects', async () => {
      const titles = await page.locator('.tm-next .tm-li').allInnerTexts();
      assert.equal(titles.length, 5);
      assert.ok(titles.slice(0, 2).some(t => t.includes('CAN transceiver debug')), titles.join());
      assert.ok(titles.slice(0, 2).some(t => t.includes('ETL jobs')), titles.join());
      await page.locator('.tm-next .tm-link').first().click();
      assert.ok(['CAN transceiver debug', 'ETL jobs'].includes(await railTitle(page)));
      await page.keyboard.press('Escape');
    });
    await check('a sub-level with a deadline gets no MVP signal, a project does', async () => {
      await setDeadline(page, 'Firmware', dayOf('2026-12-01'));
      await select(page, 'Firmware');
      assert.equal(await railTitle(page), 'Firmware');
      assert.equal(await card(page).count(), 0);
      await select(page, 'Sensor Gateway v2');
      assert.equal(await card(page).count(), 1);
      await page.keyboard.press('Escape');
    });
    await check('stale tasks are listed, and flagged on the task', async () => {
      assert.match((await page.locator('.tm-stale').innerText()).replace(/\s+/g, ' '), /SPI sensor driver 11d old/);
      await select(page, 'SPI sensor driver');
      assert.match(await rail(page).innerText(), /Hours left not updated for 11 days/);
      await select(page, 'CAN stack port');
      assert.doesNotMatch(await rail(page).innerText(), /not updated for/);
    });
    await check('backlinks: plain notes show, children do not, and they open', async () => {
      assert.match(await rail(page).innerText(), /Linked from/);
      await page.locator('.tm-backlink', { hasText: 'Bench report' }).click();
      assert.deepEqual(await page.evaluate(() => window.tm.app.workspace.opened.at(-1)), 'Notes/Bench report.md');
      await select(page, 'Hardware bring-up');
      assert.equal(await page.locator('.tm-backlink').count(), 0);
    });
    await check('timer: starts in the rail, shows in the status bar', async () => {
      await select(page, 'CAN stack port');
      await page.getByRole('button', { name: 'Start timer' }).click();
      assert.match(await page.locator('.tm-timer').innerText(), /CAN stack port/);
      assert.match(await page.locator('.tm-timer').innerText(), /0:00/);
    });
    await check('another task offers to switch', async () => {
      await select(page, 'Flash log storage');
      assert.equal(await page.getByRole('button', { name: 'Stop CAN stack port, start here' }).count(), 1);
    });
    await check('the status bar ticks on its own, with no recalculation', async () => {
      const before = await page.evaluate(() => window.tm.view.gantt.recomputes);
      await page.evaluate(() => (window.tm.skew(1.5 * 3_600_000), window.tm.view.gantt.tick()));
      assert.match(await page.locator('.tm-timer').innerText(), /1:30/);
      assert.equal(await page.evaluate(() => window.tm.view.gantt.recomputes), before);
      await shoot(page, 'timer-running');
    });
    await check('stop logs the time and prompts for hours left, defaulting to what is left', async () => {
      const left = (await item(page, 'CAN stack port')).left;
      await page.locator('.tm-timer button').click();
      assert.equal((await item(page, 'CAN stack port')).left, left - 1.5);
      assert.equal(await page.locator('.tm-timer').count(), 0);
      const input = modal(page).getByLabel('Hours left');
      assert.equal(Number(await input.inputValue()), left - 1.5);
      assert.match(await modal(page).innerText(), /Logged 1\.5h on CAN stack port/);
      await shoot(page, 'timer-prompt');
      await input.fill('40');
      await page.keyboard.press('Enter');
      assert.equal(await modal(page).count(), 0);
      assert.equal((await item(page, 'CAN stack port')).left, 40);
      await settle(page);
      const fm = await page.evaluate(i => window.tm.note(i), 'gw.fw.drv.can');
      assert.equal(fm['tm-left'], 40);
      assert.deepEqual(fm['tm-log'], ['2026-11-02 1.5']);
    });
    await check('Esc on the prompt keeps the logged hours', async () => {
      await select(page, 'Flash log storage');
      await page.getByRole('button', { name: 'Start timer' }).click();
      await page.evaluate(() => window.tm.skew(3_600_000));
      await page.locator('.tm-timer button').click();
      await page.keyboard.press('Escape');
      assert.equal(await modal(page).count(), 0);
      assert.equal((await item(page, 'Flash log storage')).left, 17);
    });
    await check('switching stops the first task and starts the second', async () => {
      await select(page, 'Flash log storage');
      await page.getByRole('button', { name: 'Start timer' }).click();
      await page.evaluate(() => window.tm.skew(1_800_000));
      await select(page, 'Runbook');
      await page.getByRole('button', { name: 'Stop Flash log storage, start here' }).click();
      await page.keyboard.press('Escape');
      assert.equal((await item(page, 'Flash log storage')).left, 16.5);
      assert.match(await page.locator('.tm-timer').innerText(), /Runbook/);
      await page.locator('.tm-timer button').click();
    });
    await check('commands are registered', async () => {
      const names = await page.evaluate(() => window.tm.commands.map(c => c.name));
      assert.deepEqual(names, ['Open Taskmaster', 'New project', 'New task under current note', 'Start/stop timer', 'Log hours']);
    });
    await check('new project opens the form at top level', async () => {
      await run(page, 'new-project');
      assert.equal(await page.locator('.tm-rail form').getByLabel('Inside').inputValue(), '');
      await page.keyboard.press('Escape');
    });
    await check('new task under current note opens the form inside it', async () => {
      const id = await idOf(page, 'Drivers');
      await page.evaluate(i => window.tm.app.workspace.setActive(i), id);
      await run(page, 'new-task');
      assert.equal(await page.locator('.tm-rail form').getByLabel('Inside').inputValue(), id);
      await page.keyboard.press('Escape');
    });
    await check('new task with no item open says so', async () => {
      await page.evaluate(() => window.tm.app.workspace.setActive('Notes/Bench report.md'));
      await run(page, 'new-task');
      assert.match(await page.evaluate(() => window.tm.notices.at(-1)), /not a Taskmaster item/);
      assert.equal(await page.locator('.tm-rail form').count(), 0);
    });
    await check('timer command starts on the current note, and stops', async () => {
      const id = await idOf(page, 'Runbook');
      await page.evaluate(i => window.tm.app.workspace.setActive(i), id);
      await run(page, 'toggle-timer');
      assert.match(await page.locator('.tm-timer').innerText(), /Runbook/);
      await page.evaluate(() => window.tm.skew(3_600_000));
      await run(page, 'toggle-timer');
      assert.equal(await page.locator('.tm-timer').count(), 0);
      assert.equal(await modal(page).getByLabel('Hours left').count(), 1);
      await page.keyboard.press('Escape');
    });
    await check('timer command refuses a parent', async () => {
      await page.evaluate(i => window.tm.app.workspace.setActive(i), await idOf(page, 'Drivers'));
      await run(page, 'toggle-timer');
      assert.match(await page.evaluate(() => window.tm.notices.at(-1)), /Open a task/);
      assert.equal(await page.locator('.tm-timer').count(), 0);
    });
    await check('log hours command logs on the current note, with a date', async () => {
      await page.evaluate(i => window.tm.app.workspace.setActive(i), await idOf(page, 'Frame format + CRC'));
      await run(page, 'log-hours');
      await shoot(page, 'log-hours');
      await modal(page).getByLabel('Hours').fill('2.5');
      await modal(page).getByLabel('Date').fill('2026-11-02');
      await modal(page).getByRole('button', { name: 'Log' }).click();
      assert.equal((await item(page, 'Frame format + CRC')).spent, 2.5);
      assert.equal(await modal(page).count(), 0);
    });
    await check('settings: capacity, stale days', async () => {
      await page.evaluate(() => window.tm.openSettings());
      await shoot(page, 'settings');
      await row(page, 'Weekly capacity').locator('input').fill('35');
      await row(page, 'Weekly capacity').locator('input').blur();
      assert.equal(await page.evaluate(() => window.tm.store.state.settings.weekly), 35);
      assert.equal(await page.locator('.tm-cap-in').inputValue(), '35');
      await row(page, 'Stale after').locator('input').fill('3');
      await row(page, 'Stale after').locator('input').blur();
      assert.equal(await page.evaluate(() => window.tm.store.state.settings.staleDays), 3);
    });
    await check('settings: a bad value goes back', async () => {
      await row(page, 'Stale after').locator('input').fill('0');
      await row(page, 'Stale after').locator('input').blur();
      assert.equal(await row(page, 'Stale after').locator('input').inputValue(), '3');
    });
    await check('settings: a week override can be added and removed', async () => {
      await row(page, 'Add a week').locator('input[type=week]').fill('2026-W50');
      await row(page, 'Add a week').locator('input[type=number]').fill('12');
      await row(page, 'Add a week').getByRole('button', { name: 'Add' }).click();
      assert.deepEqual(Object.values(await page.evaluate(() => window.tm.store.state.settings.weekCap)), [12]);
      assert.equal(await row(page, '2026-W50').count(), 1);
      await row(page, '2026-W50').getByLabel('Remove').click();
      assert.deepEqual(await page.evaluate(() => window.tm.store.state.settings.weekCap), {});
      assert.equal(await row(page, '2026-W50').count(), 0);
    });
    await check('settings: seeded holidays list, one can be added and removed', async () => {
      const before = await page.evaluate(() => window.tm.store.state.settings.holidays.length);
      assert.equal(await row(page, '2026-12-24').count(), 1);
      await row(page, 'Add a holiday').locator('input').fill('2026-11-20');
      await row(page, 'Add a holiday').getByRole('button', { name: 'Add' }).click();
      assert.equal(await page.evaluate(() => window.tm.store.state.settings.holidays.length), before + 1);
      await row(page, '2026-11-20').getByLabel('Remove').click();
      assert.equal(await page.evaluate(() => window.tm.store.state.settings.holidays.length), before);
    });
    await check('settings: projects folder refuses a missing folder and says why', async () => {
      await row(page, 'Projects folder').locator('input').fill('Nowhere');
      await row(page, 'Projects folder').locator('input').blur();
      assert.match(await page.evaluate(() => window.tm.notices.at(-1)), /Nowhere/);
      assert.equal(await page.evaluate(() => window.tm.store.projectsFolder), 'Projects/');
      assert.equal(await row(page, 'Projects folder').locator('input').inputValue(), 'Projects/');
      await page.evaluate(() => window.tm.closeSettings());
    });
    await page.close();
  }

  // The new panels, in both themes.
  for (const theme of ['light', 'dark']) {
    const page = await open(`mini&theme=${theme}`, theme, tall);
    await select(page, 'Alpha');
    await shoot(page, `rail-mvp-${theme}`);
    await rail(page).evaluate(e => (e.scrollTop = e.scrollHeight));
    await shoot(page, `rail-lists-${theme}`);
    await select(page, 'Bench outage');
    await shoot(page, `rail-external-${theme}`);
    await select(page, 'Must one');
    await page.getByRole('button', { name: 'Start timer' }).click();
    await page.evaluate(() => (window.tm.skew(5_400_000), window.tm.view.gantt.tick()));
    await shoot(page, `rail-timer-${theme}`);
    await page.locator('.tm-timer button').click();
    await shoot(page, `prompt-left-${theme}`);
    await page.keyboard.press('Escape');
    await page.evaluate(i => window.tm.app.workspace.setActive(i), await idOf(page, 'Should one'));
    await run(page, 'log-hours');
    await shoot(page, `prompt-log-${theme}`);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.tm.openSettings());
    await shoot(page, `settings-${theme}`);
    await page.close();

    const full = await open(`theme=${theme}`, theme, tall);
    await shoot(full, `rail-top-${theme}`);
    await full.locator('.tm-rail').evaluate(e => (e.scrollTop = e.scrollHeight));
    await shoot(full, `rail-top-lists-${theme}`);
    await select(full, 'CAN stack port');
    await shoot(full, `rail-backlinks-${theme}`);
    await select(full, 'SPI sensor driver');
    await shoot(full, `rail-stale-${theme}`);
    await full.close();
  }
}
