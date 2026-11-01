/** Creating, moving, renaming, deleting, external items and linked notes: real mouse and keyboard on the real store. */
import assert from 'node:assert/strict';

const tall = { width: 1600, height: 1300 };

export async function structureChecks({ open, shoot, check, rowByTitle, railTitle, status, settle }) {
  const paths = page => page.evaluate(() => [...window.tm.vault.notes.keys()]);
  const noteAt = (page, path) => page.evaluate(p => window.tm.vault.frontmatter(p), path);
  const pathEnding = async (page, tail) => (await paths(page)).find(p => p.endsWith(tail));
  const item = (page, title) => page.evaluate(t => Object.values(window.tm.store.state.items).find(i => i.title === t) ?? null, title);
  const idOf = (page, title) => page.evaluate(t => Object.keys(window.tm.store.state.items).find(k => window.tm.store.state.items[k].title === t), title);
  const undoLabel = page => page.evaluate(() => window.tm.store.undoLabel);
  const undo = async page => {
    await page.mouse.move(5, 5);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Control+z');
    await settle(page);
  };
  const select = (page, title) => rowByTitle(page, title).locator('.tm-t').click();
  const form = page => page.locator('.tm-rail form');
  const name = page => form(page).getByLabel('Name');

  /** Presses on a row and stops over a share of another, button still down. */
  const dragRow = async (page, from, to, share) => {
    const a = await rowByTitle(page, from).locator('.tm-t').boundingBox();
    const b = await rowByTitle(page, to).boundingBox();
    await page.mouse.move(a.x + 10, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 150, b.y + b.height * share, { steps: 8 });
  };
  const drop = async page => {
    await page.mouse.up();
    await page.mouse.move(5, 5);
    await settle(page);
  };

  // Creating
  {
    const page = await open('theme=light', 'light', tall);
    await check('+ Project and + Item open one form in the rail; Esc closes it first', async () => {
      await page.locator('.tm-top button', { hasText: '+ Project' }).click();
      assert.equal(await form(page).count(), 1);
      assert.equal(await form(page).getByLabel('Inside').inputValue(), '');
      await shoot(page, 'form-project');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Name');
      await select(page, 'Firmware');
      await page.locator('.tm-top button', { hasText: '+ Item' }).click();
      assert.equal(await form(page).getByLabel('Inside').inputValue(), await idOf(page, 'Firmware'));
      await page.keyboard.press('Escape');
      assert.equal(await form(page).count(), 0);
      assert.equal(await railTitle(page), 'Firmware');
      await page.keyboard.press('Escape');
    });

    await check('N opens the form with the selected parent, else the selected item\'s parent, else the focus; not while typing', async () => {
      await page.mouse.move(5, 5);
      await select(page, 'CAN stack port');
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('n');
      assert.equal(await form(page).getByLabel('Inside').inputValue(), await idOf(page, 'Drivers'));
      assert.equal(await name(page).inputValue(), '', 'the N was typed into the field');
      await name(page).pressSequentially('nn');
      assert.equal(await name(page).inputValue(), 'nn');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      const row = rowByTitle(page, 'Test Rig Automation');
      await row.hover();
      await row.locator('.tm-fb', { hasText: 'Focus' }).click();
      await page.mouse.move(5, 5);
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('n');
      assert.equal(await form(page).getByLabel('Inside').inputValue(), await idOf(page, 'Test Rig Automation'));
      await page.keyboard.press('Escape');
      await page.locator('.tm-up').click();
    });

    await check('+ Add on a row and in details; none on milestones or external rows', async () => {
      const row = rowByTitle(page, 'Protocol');
      await row.hover();
      await row.locator('.tm-fb', { hasText: '+ Add' }).click();
      assert.equal(await form(page).getByLabel('Inside').inputValue(), await idOf(page, 'Protocol'));
      await shoot(page, 'form-row-add');
      await page.keyboard.press('Escape');
      const leaf = rowByTitle(page, 'Runbook');
      await leaf.hover();
      assert.equal(await leaf.locator('.tm-fb', { hasText: '+ Add' }).isVisible(), true);
      assert.equal(await leaf.locator('.tm-n').isVisible(), false);
      assert.equal(await rowByTitle(page, 'Release candidate').locator('.tm-fb').count(), 0);
      assert.equal(await rowByTitle(page, 'Test bench recalibration').locator('.tm-fb').count(), 0);
      await select(page, 'Drivers');
      await page.locator('.tm-rail button', { hasText: '+ Add' }).click();
      assert.equal(await form(page).getByLabel('Inside').inputValue(), await idOf(page, 'Drivers'));
      await page.keyboard.press('Escape');
      await select(page, 'Runbook');
      await page.locator('.tm-rail button', { hasText: '+ Add' }).click();
      assert.equal(await form(page).getByLabel('Inside').inputValue(), await idOf(page, 'Runbook'));
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    });

    await check('Enter adds, the form stays for the next item, and the row shows new with no plan', async () => {
      const before = await page.locator('.tm-rail').count();
      assert.equal(before, 1);
      const row = rowByTitle(page, 'Protocol');
      await row.hover();
      await row.locator('.tm-fb', { hasText: '+ Add' }).click();
      await name(page).fill('Handshake');
      await form(page).getByLabel('Hours').fill('8');
      await page.keyboard.press('Enter');
      await settle(page);
      assert.equal(await name(page).inputValue(), '');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Name');
      assert.match(await rowByTitle(page, 'Handshake').locator('.tm-s').textContent(), /● new/);
      assert.ok(await pathEnding(page, 'Protocol/Handshake.md'));
      assert.match(await page.locator('.tm-rail').textContent(), /Handshake/);
      await shoot(page, 'form-after-add');
      assert.equal(await undoLabel(page), 'Added Handshake');
    });

    await check('the option makes the next item depend on the one just added', async () => {
      await form(page).getByLabel(/Also depends on/).check();
      await name(page).fill('After handshake');
      await page.keyboard.press('Enter');
      await settle(page);
      const it = await item(page, 'After handshake');
      assert.deepEqual(it.deps, [await idOf(page, 'Handshake')]);
      assert.equal(it.left, 0);
      await page.keyboard.press('Escape');
    });

    await check('name required; milestone needs a parent; refusals show in the form', async () => {
      await page.locator('.tm-top button', { hasText: '+ Project' }).click();
      await page.keyboard.press('Enter');
      assert.match(await form(page).locator('.tm-card-crit').textContent(), /Give it a name/);
      await form(page).getByRole('button', { name: 'Milestone' }).click();
      await name(page).fill('Lonely');
      await page.keyboard.press('Enter');
      assert.match(await form(page).locator('.tm-card-crit').textContent(), /needs a parent/);
      await shoot(page, 'form-refused');
      assert.equal(await item(page, 'Lonely'), null);
      await page.keyboard.press('Escape');
    });

    await check('a new project: the form continues inside it', async () => {
      await page.locator('.tm-top button', { hasText: '+ Project' }).click();
      await name(page).fill('Fresh project');
      await page.keyboard.press('Enter');
      await settle(page);
      assert.equal(await form(page).getByLabel('Inside').inputValue(), await idOf(page, 'Fresh project'));
      await name(page).fill('First task');
      await form(page).getByLabel('Hours').fill('6');
      await page.keyboard.press('Enter');
      await settle(page);
      assert.equal((await item(page, 'First task')).parent, await idOf(page, 'Fresh project'));
      assert.ok(await pathEnding(page, 'Fresh project/Fresh project.md'), 'the project moved into its folder');
      assert.ok(await pathEnding(page, 'Fresh project/First task.md'));
      assert.equal(await form(page).getByLabel('Inside').inputValue(), await idOf(page, 'Fresh project'), 'parent followed its note');
      await page.keyboard.press('Escape');
    });

    await check('choosing a parent with hours warns; adding moves its note and keeps it selected', async () => {
      await select(page, 'Runbook');
      await page.locator('.tm-rail button', { hasText: '+ Add' }).click();
      assert.match(await form(page).textContent(), /6h.*budget/s);
      await shoot(page, 'form-budget-warning');
      await name(page).fill('Part one');
      await form(page).getByLabel('Hours').fill('2');
      await page.keyboard.press('Enter');
      await settle(page);
      assert.ok(await pathEnding(page, 'Runbook/Runbook.md'));
      const fm = await noteAt(page, await idOf(page, 'Runbook'));
      assert.equal(fm['tm-budget'], 6);
      assert.equal(fm['tm-left'], 0);
      assert.equal((await item(page, 'Part one')).parent, await idOf(page, 'Runbook'));
      await page.keyboard.press('Escape');
      assert.equal(await railTitle(page), 'Runbook');
      await page.keyboard.press('Escape');
    });

    await check('title clash gets a suffix', async () => {
      await rowByTitle(page, 'Protocol').hover();
      await rowByTitle(page, 'Protocol').locator('.tm-fb', { hasText: '+ Add' }).click();
      await name(page).fill('OTA updates');
      await page.keyboard.press('Enter');
      await settle(page);
      assert.ok(await item(page, 'OTA updates 2'));
      await page.keyboard.press('Escape');
    });

    await check('the dependency picker in the form leaves out loops', async () => {
      await select(page, 'Frame format + CRC');
      await page.locator('.tm-rail button', { hasText: '+ Add' }).click();
      const options = await form(page).getByLabel('Add dependency').locator('option').allTextContents();
      assert.ok(!options.includes('OTA updates'), 'OTA waits for Frame format, so a child of it cannot wait for OTA');
      assert.ok(options.includes('CAN stack port'));
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    });

    await check('an external item: dates required, sorted into the section', async () => {
      await page.locator('.tm-top button', { hasText: '+ Item' }).click();
      await form(page).getByRole('button', { name: 'External' }).click();
      await name(page).fill('Lab move');
      await page.keyboard.press('Enter');
      assert.match(await form(page).locator('.tm-card-crit').textContent(), /start and an end/);
      await form(page).getByLabel('Start').fill('2026-11-09');
      await form(page).getByLabel('End').fill('2026-11-10');
      await shoot(page, 'form-external');
      await page.keyboard.press('Enter');
      await settle(page);
      assert.ok(await pathEnding(page, '_external/Lab move.md'));
      await page.keyboard.press('Escape');
      const titles = await page.locator('.tm-row').evaluateAll(rows => rows.sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map(r => r.querySelector('.tm-t').textContent));
      const at = titles.indexOf('External');
      assert.deepEqual(titles.slice(at, at + 3), ['External', 'Lab move', 'Test bench recalibration']);
    });

    await check('undo walks every creation back, across files', async () => {
      for (let i = 0; i < 12 && !(await page.locator('.tm-undo').isDisabled()); i++) await undo(page);
      assert.equal(await page.locator('.tm-undo').isDisabled(), true);
      assert.equal(await item(page, 'Handshake'), null);
      assert.equal(await item(page, 'Fresh project'), null);
      assert.equal(await pathEnding(page, 'Runbook/Runbook.md'), undefined);
      assert.equal((await item(page, 'Runbook')).left, 6);
    });
    await page.close();
  }

  // Moving
  {
    const page = await open('theme=light', 'light', tall);
    await check('mid-drag: outline and consequence with no layout shift, then the drop moves the note', async () => {
      const boxes = async () => ({
        top: await page.locator('.tm-top').boundingBox(),
        tree: await page.locator('.tm-tree').boundingBox(),
        rail: await page.locator('.tm-rail').boundingBox(),
        status: await page.locator('.tm-status').boundingBox(),
        row: await rowByTitle(page, 'ETL jobs').boundingBox(),
      });
      const before = await boxes();
      await dragRow(page, 'CAN stack port', 'Runbook', 0.5);
      assert.deepEqual(await boxes(), before);
      assert.equal(await page.locator('.tm-drop.tm-drop-in').count(), 1);
      assert.equal(await page.locator('.tm-drag-ghost').isVisible(), true);
      assert.match(await status(page), /Move into Runbook: its 6h become its budget/);
      await shoot(page, 'row-drag-into');
      await drop(page);
      assert.equal(await page.locator('.tm-drop').count(), 0);
      assert.ok(await pathEnding(page, 'Runbook/CAN stack port.md'));
      assert.ok(await pathEnding(page, 'Runbook/Runbook.md'));
      assert.equal((await item(page, 'Runbook')).budget, 6);
      assert.equal((await item(page, 'CAN stack port')).parent, await idOf(page, 'Runbook'));
      await shoot(page, 'row-drag-after');
      await undo(page);
      assert.equal((await item(page, 'Runbook')).left, 6);
      assert.equal((await item(page, 'CAN stack port')).parent, await idOf(page, 'Drivers'));
    });

    await check('top quarter places before, bottom quarter after, with an insertion line', async () => {
      await dragRow(page, 'Flash log storage', 'SPI sensor driver', 0.1);
      assert.equal(await page.locator('.tm-drop.tm-drop-line').count(), 1);
      assert.match(await status(page), /Place before SPI sensor driver/);
      await shoot(page, 'row-drag-before');
      await drop(page);
      const order = page.locator('.tm-row[data-row]');
      const titles = async () => (await order.evaluateAll(rows => rows.sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map(r => r.querySelector('.tm-t').title)));
      let t = await titles();
      assert.ok(t.indexOf('Flash log storage') < t.indexOf('SPI sensor driver'), t.join());
      await dragRow(page, 'Flash log storage', 'CAN stack port', 0.9);
      assert.match(await status(page), /Place after CAN stack port/);
      await drop(page);
      t = await titles();
      assert.ok(t.indexOf('Flash log storage') > t.indexOf('CAN stack port'), t.join());
      await undo(page);
      await undo(page);
    });

    await check('a move drops a project at the top level and leaves plans alone', async () => {
      const plan = await page.evaluate(() => JSON.stringify(Object.values(window.tm.store.state.plan)));
      await dragRow(page, 'Runbook', 'Sensor Gateway v2', 0.1);
      assert.match(await status(page), /Place before Sensor Gateway v2 as a project/);
      await drop(page);
      assert.equal((await item(page, 'Runbook')).parent, null);
      assert.equal(await page.evaluate(() => JSON.stringify(Object.values(window.tm.store.state.plan))), plan);
      await undo(page);
    });

    await check('the last child leaving shows its parent getting hours back', async () => {
      await page.evaluate(() => {
        const { store, edits, vault } = window.tm;
        store.apply(edits.setBudget(window.tm.path('gw.fw.pr'), 80));
        return vault;
      });
      await settle(page);
      const parent = await idOf(page, 'Protocol');
      for (const t of ['Frame format + CRC', 'OTA updates']) await page.evaluate(([p, id]) => window.tm.store.move(id, null), [parent, await idOf(page, t)]);
      await settle(page);
      await dragRow(page, 'Remote diagnostics', 'Drivers', 0.5);
      assert.match(await status(page), /Protocol's 80h budget becomes hours again/);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await undo(page);
      await undo(page);
      await undo(page);
    });

    await check('illegal targets refuse the drop and say why, in the status bar', async () => {
      const was = await undoLabel(page);
      const refused = async (from, to, share, why) => {
        await dragRow(page, from, to, share);
        assert.match(await status(page), why);
        assert.equal(await page.locator('.tm-drop.tm-drop-no').count(), 1, `${from} onto ${to}`);
        await drop(page);
        assert.equal(await undoLabel(page), was, `${from} onto ${to} moved`);
      };
      await refused('Firmware', 'CAN stack port', 0.5, /⚠ An item cannot move inside itself/);
      await refused('Firmware', 'Drivers', 0.1, /⚠ An item cannot move inside itself/);
      await refused('Runbook', 'Rig ready for HIL', 0.5, /⚠ Milestones cannot have children/);
      await refused('Runbook', 'Test bench recalibration', 0.5, /⚠ External items cannot have children/);
      await refused('Runbook', 'Test bench recalibration', 0.1, /⚠ External items stay in their own section/);
      await refused('Test bench recalibration', 'Protocol', 0.5, /⚠ External items stay in their own section/);
      await refused('Release candidate', 'Sensor Gateway v2', 0.1, /⚠ A milestone needs a parent/);
      await refused('ETL jobs', 'Production cutover', 0.5, /⚠ That would create a dependency loop/);
      await dragRow(page, 'Runbook', 'Rig ready for HIL', 0.5);
      await shoot(page, 'row-drag-refused');
      await page.keyboard.press('Escape');
      await page.mouse.up();
    });

    await check('Esc cancels a row drag; a plain click still selects', async () => {
      const was = await undoLabel(page);
      await select(page, 'Runbook');
      await dragRow(page, 'CAN stack port', 'Drivers', 0.5);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.tm-drop').count(), 0);
      assert.equal(await railTitle(page), 'Runbook', 'Esc went to the drag, not the selection');
      await page.mouse.up();
      await settle(page);
      assert.equal(await undoLabel(page), was);
      await rowByTitle(page, 'ETL jobs').locator('.tm-t').click();
      assert.equal(await railTitle(page), 'ETL jobs');
      await page.keyboard.press('Escape');
    });

    await check('a collapsed target opens to show what landed in it', async () => {
      await rowByTitle(page, 'Drivers').locator('.tm-col').click();
      await dragRow(page, 'Runbook', 'Drivers', 0.5);
      await drop(page);
      assert.equal(await rowByTitle(page, 'Runbook').count(), 1);
      await undo(page);
    });

    await check('Inside picker: lists the tree, moves, Top level, refusals, and selection follows', async () => {
      await select(page, 'Runbook');
      const inside = page.locator('.tm-rail').getByLabel('Inside');
      const texts = await inside.locator('option').allTextContents();
      assert.equal(texts[0], 'Top level (project)');
      assert.ok(texts.some(t => t.trim() === 'Drivers'));
      assert.ok(!texts.some(t => t.includes('Test bench')), 'external listed');
      assert.equal(await inside.locator('option', { hasText: 'Rig ready for HIL' }).isDisabled(), true);
      await shoot(page, 'inside-picker');
      await inside.selectOption({ value: await idOf(page, 'Drivers') });
      await settle(page);
      assert.ok(await pathEnding(page, 'Drivers/Runbook.md'));
      assert.equal(await railTitle(page), 'Runbook');
      assert.equal(await inside.inputValue(), await idOf(page, 'Drivers'));
      await inside.selectOption({ value: '' });
      await settle(page);
      assert.equal((await item(page, 'Runbook')).parent, null);
      await undo(page);
      await undo(page);
      await select(page, 'ETL jobs');
      const was = await undoLabel(page);
      await page.locator('.tm-rail').getByLabel('Inside').selectOption({ value: await idOf(page, 'Production cutover') });
      await settle(page);
      assert.match(await status(page), /⚠ That would create a dependency loop/);
      assert.equal(await undoLabel(page), was);
      assert.equal(await page.locator('.tm-rail').getByLabel('Inside').inputValue(), await idOf(page, 'Data Pipeline Migration'));
      await select(page, 'Firmware');
      assert.equal(await page.locator('.tm-rail').getByLabel('Inside').locator('option', { hasText: 'Drivers' }).isDisabled(), true);
      await select(page, 'Release candidate');
      assert.equal(await page.locator('.tm-rail').getByLabel('Inside').locator('option').first().isDisabled(), true);
      await page.keyboard.press('Escape');
    });
    await page.close();
  }

  // Renaming and deleting
  {
    const page = await open('theme=light', 'light', tall);
    await check('rename in details renames the note, keeps selection, and links follow', async () => {
      await select(page, 'Drivers');
      await page.locator('.tm-rail').getByLabel('Name').fill('Device drivers');
      await page.keyboard.press('Enter');
      await settle(page);
      assert.equal(await railTitle(page), 'Device drivers');
      assert.ok(await pathEnding(page, 'Device drivers/Device drivers.md'));
      assert.ok(await pathEnding(page, 'Device drivers/CAN stack port.md'));
      assert.equal((await item(page, 'CAN stack port')).parent, await idOf(page, 'Device drivers'));
      assert.equal(await rowByTitle(page, 'CAN stack port').count(), 1);
      assert.match(await status(page), /Renamed Drivers to Device drivers/);
      await shoot(page, 'renamed');
      await undo(page);
      assert.equal(await railTitle(page), 'Drivers');
      assert.equal((await item(page, 'CAN stack port')).parent, await idOf(page, 'Drivers'));
      await page.keyboard.press('Escape');
    });

    await check('blank name goes back, leaving the field commits', async () => {
      await select(page, 'Runbook');
      const field = page.locator('.tm-rail').getByLabel('Name');
      await field.fill('');
      await field.blur();
      await settle(page);
      assert.equal(await field.inputValue(), 'Runbook');
      await field.fill('Ops runbook');
      await field.blur();
      await settle(page);
      assert.equal(await railTitle(page), 'Ops runbook');
      await undo(page);
      await page.keyboard.press('Escape');
    });

    await check('delete asks for a second click with the count, then goes to the trash; undo restores', async () => {
      await select(page, 'Protocol');
      const del = page.locator('.tm-rail button.tm-del');
      assert.equal((await del.textContent()).trim(), 'Delete');
      await del.click();
      assert.match(await del.textContent(), /Click again to delete 4 items/);
      await shoot(page, 'delete-armed');
      await page.mouse.move(5, 5);
      assert.equal((await del.textContent()).trim(), 'Delete', 'leaving disarms');
      await del.click();
      await del.click();
      await settle(page);
      assert.equal(await item(page, 'OTA updates'), null);
      assert.equal(await rowByTitle(page, 'Protocol').count(), 0);
      assert.equal(await railTitle(page), 'All projects');
      assert.equal((await page.evaluate(() => window.tm.vault.trashed)).length >= 4, true);
      assert.equal(await page.evaluate(() => Object.keys(window.tm.store.state.plan).some(p => p.includes('/Protocol/'))), false);
      assert.deepEqual((await item(page, 'HIL test suite')).deps.some(d => d.includes('Frame format')), false);
      await undo(page);
      assert.ok(await item(page, 'OTA updates'));
      assert.equal(await page.evaluate(() => Object.keys(window.tm.store.state.plan).some(p => p.includes('/Protocol/'))), true);
      assert.equal((await item(page, 'HIL test suite')).deps.some(d => d.includes('Frame format')), true);
      assert.equal((await page.evaluate(() => window.tm.vault.notes.size)) > 0, true);
    });

    await check('one item says one item', async () => {
      await select(page, 'Runbook');
      await page.locator('.tm-rail button.tm-del').click();
      assert.match(await page.locator('.tm-rail button.tm-del').textContent(), /Click again to delete 1 item$/);
      await page.mouse.move(5, 5);
      await page.keyboard.press('Escape');
    });
    await page.close();
  }

  // External items
  {
    const page = await open('theme=light', 'light', tall);
    const ext = 'Test bench recalibration';
    const rail = page.locator('.tm-rail');
    await check('rail: name, dates that move the forecast, blocks add and remove, delete', async () => {
      await select(page, ext);
      await shoot(page, 'external-rail');
      await rail.getByLabel('Start').fill('2026-12-07');
      await rail.getByLabel('Start').blur();
      await settle(page);
      let it = await item(page, ext);
      assert.equal(it.pinS, it.pinE, 'start stops at end');
      await rail.getByLabel('End').fill('2026-12-18');
      await rail.getByLabel('End').blur();
      await settle(page);
      assert.equal((await noteAt(page, await idOf(page, ext)))['tm-pin-end'], '2026-12-18');
      assert.match(await status(page), /forecast moved/i);

      const blocks = rail.getByLabel('Add blocked item');
      const options = await blocks.locator('option').allTextContents();
      assert.ok(options.includes('Runbook'));
      assert.ok(!options.includes('HIL test suite'), 'already blocked');
      assert.ok(!options.includes(ext));
      await blocks.selectOption({ label: 'Runbook' });
      await settle(page);
      assert.deepEqual((await item(page, 'Runbook')).deps, [await idOf(page, ext)]);
      assert.match(await rail.textContent(), /Runbook/);
      await rail.getByLabel('Stop blocking Runbook').click();
      await settle(page);
      assert.deepEqual((await item(page, 'Runbook')).deps, []);
      await rail.getByLabel('Name').fill('Bench move');
      await page.keyboard.press('Enter');
      await settle(page);
      assert.equal(await railTitle(page), 'Bench move');
      assert.ok(await pathEnding(page, '_external/Bench move.md'));
      await rail.locator('button.tm-del').click();
      await rail.locator('button.tm-del').click();
      await settle(page);
      assert.equal(await rowByTitle(page, 'Bench move').count(), 0);
      assert.equal((await item(page, 'HIL test suite')).deps.some(d => d.includes('_external')), false);
      for (let i = 0; i < 6 && !(await page.locator('.tm-undo').isDisabled()); i++) await undo(page);
      it = await item(page, ext);
      assert.ok(it);
      assert.equal((await item(page, 'HIL test suite')).deps.some(d => d.includes('_external')), true);
    });

    await check('focused view lists only externals referenced by what it shows', async () => {
      await page.mouse.move(5, 5);
      await page.keyboard.press('Escape');
      const dp = rowByTitle(page, 'Sensor Gateway v2');
      await dp.hover();
      await dp.locator('.tm-fb', { hasText: 'Focus' }).click();
      assert.equal(await rowByTitle(page, ext).count(), 1);
      await page.locator('.tm-up').click();
      const dpr = rowByTitle(page, 'Data Pipeline Migration');
      await dpr.hover();
      await dpr.locator('.tm-fb', { hasText: 'Focus' }).click();
      assert.equal(await rowByTitle(page, ext).count(), 0);
      await page.locator('.tm-up').click();
    });
    await page.close();
  }

  // Linked notes
  {
    const page = await open('theme=light', 'light', tall);
    const rail = page.locator('.tm-rail');
    await check('Link opens the fuzzy picker; pick, unlink in one click, undo', async () => {
      await select(page, 'Runbook');
      await rail.locator('button', { hasText: 'Link note' }).click();
      const modal = page.locator('.tm-fake-modal');
      await modal.locator('input').fill('wire');
      assert.match(await modal.textContent(), /Wire format/);
      await shoot(page, 'link-picker');
      await page.keyboard.press('Enter');
      await settle(page);
      assert.equal(await modal.count(), 0);
      assert.match(await rail.textContent(), /\[\[Wire format\]\]/);
      assert.deepEqual((await noteAt(page, await idOf(page, 'Runbook')))['tm-notes'], ['[[Wire format]]']);
      await rail.getByLabel('Unlink Wire format').click();
      await settle(page);
      assert.deepEqual((await noteAt(page, await idOf(page, 'Runbook')))['tm-notes'], []);
      await undo(page);
      assert.match(await rail.textContent(), /\[\[Wire format\]\]/);
    });

    await check('nothing matches: offers to create the note, and links it', async () => {
      await rail.locator('button', { hasText: 'Link note' }).click();
      const modal = page.locator('.tm-fake-modal');
      await modal.locator('input').fill('Brand new note');
      assert.match(await modal.textContent(), /Create "Brand new note"/);
      await shoot(page, 'link-create');
      await page.keyboard.press('Enter');
      await settle(page);
      assert.ok(await pathEnding(page, 'Brand new note.md'));
      assert.match(await rail.textContent(), /\[\[Brand new note\]\]/);
      await undo(page);
      assert.equal(await pathEnding(page, 'Brand new note.md'), undefined);
    });

    await check('Esc in the picker closes only the picker', async () => {
      await rail.locator('button', { hasText: 'Link note' }).click();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.tm-fake-modal').count(), 0);
      assert.equal(await railTitle(page), 'Runbook');
    });

    await check('every details panel has Link', async () => {
      for (const title of ['Firmware', 'Release candidate', 'Test bench recalibration']) {
        await select(page, title);
        assert.equal(await rail.locator('button', { hasText: 'Link note' }).count(), 1, title);
      }
    });
    await page.close();
  }

  // Dark theme, mid-gesture
  await check('dark: form and mid-row-drag', async () => {
    const dark = await open('theme=dark', 'dark', tall);
    await dark.locator('.tm-top button', { hasText: '+ Item' }).click();
    await shoot(dark, 'form-dark');
    await dark.keyboard.press('Escape');
    await dragRow(dark, 'Runbook', 'ETL jobs', 0.1);
    await shoot(dark, 'row-drag-dark');
    await dark.keyboard.press('Escape');
    await dark.mouse.up();
    await dark.close();
  });
}
