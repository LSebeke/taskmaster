/** The steps of `npm run smoke`, in order. Each builds on what the last left in the vault. */
import assert from 'node:assert/strict';

export function smokeSteps(w) {
  return [
    ['probe', async () => {
      const p = w.page;
      const out = await p.evaluate(async () => {
        const log = [];
        const { vault, metadataCache: mc, fileManager: fm } = app;
        const r1 = vault.on('rename', (f, old) => log.push(['rename', old, f.path, f.children ? 'folder' : 'file', vault.getAbstractFileByPath(f.path) === f, vault.getAbstractFileByPath(old) ? 'oldStill' : 'oldGone', !!mc.getCache(f.path)]));
        const r2 = vault.on('delete', f => log.push(['vdelete', f.path]));
        const r3 = mc.on('deleted', f => log.push(['mcdeleted', f.path]));
        const r4 = mc.on('changed', f => log.push(['changed', f.path]));
        const mark = x => log.push(['--', x]);
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        await vault.createFolder('Px');
        await vault.createFolder('Px/Sub');
        await vault.create('Px/Sub/A.md', '---\ntm-type: item\n---\n');
        await vault.create('Px/B.md', '---\nlink: "[[A]]"\n---\n');
        await sleep(300);
        mark('file rename start');
        const pr = fm.renameFile(vault.getAbstractFileByPath('Px/B.md'), 'Px/Sub/B.md');
        mark('called');
        await pr;
        mark('resolved; cache ' + !!mc.getCache('Px/Sub/B.md'));
        await sleep(300);
        mark('folder rename start');
        await fm.renameFile(vault.getAbstractFileByPath('Px/Sub'), 'Px/Sub2');
        mark('resolved');
        await sleep(300);
        log.push(['exists', await vault.adapter.exists('Px/Sub2/A.md'), !!vault.getFileByPath('Px/Sub2/A.md')]);
        await vault.createFolder('Py');
        await vault.create('Py/A.md', '---\nx: 1\n---\n');
        await sleep(300);
        log.push(['resolve A from Py', mc.getFirstLinkpathDest('A', 'Py/x.md')?.path, 'from Px/Sub2', mc.getFirstLinkpathDest('A', 'Px/Sub2/x.md')?.path, 'from root', mc.getFirstLinkpathDest('A', '')?.path, 'from Pz', mc.getFirstLinkpathDest('A', 'Pz/x.md')?.path]);
        log.push(['linktext', mc.fileToLinktext(vault.getFileByPath('Py/A.md'), 'Px/Sub2/x.md'), mc.fileToLinktext(vault.getFileByPath('Px/Sub2/A.md'), 'Px/Sub2/x.md'), mc.fileToLinktext(vault.getFileByPath('Px/Sub2/B.md'), 'Px/Sub2/x.md')]);
        log.push(['file text', await vault.read(vault.getFileByPath('Px/Sub2/B.md'))]);
        mark('trash');
        await fm.trashFile(vault.getFileByPath('Py/A.md'));
        mark('trashed');
        await sleep(300);
        mark('trash folder');
        await fm.trashFile(vault.getAbstractFileByPath('Px'));
        mark('trashed');
        await sleep(300);
        vault.offref(r1); vault.offref(r2); mc.offref(r3); mc.offref(r4);
        return log;
      });
      for (const l of out) console.log(JSON.stringify(l));
      console.log(await w.page.evaluate(() => process.versions.electron + ' ' + apiVersion + ' ' + navigator.userAgent));
    }],
  ];
}
