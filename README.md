# Taskmaster

Gantt-first project management for a solo engineer, as a desktop Obsidian plugin. Tracks hours against plan, forecasts finish dates from your real capacity, finds the critical chain, and tells you when to cut scope. Your notes are the data: one note per item, with `tm-*` frontmatter.

## Install

```sh
npm ci
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` to `<vault>/.obsidian/plugins/taskmaster/`, then enable Taskmaster under Community plugins. Run the `Open Taskmaster` command. Requires Obsidian 1.7.2 or later.

## Privacy and data

- **No network.** Taskmaster sends nothing anywhere and loads nothing remote: no telemetry, no update checks, no accounts. CI fails if network code is added (`tests/guard.test.ts`).
- **What it reads:** the frontmatter and to-do checkboxes of notes in your vault, through Obsidian's metadata cache.
- **What it writes:**
  - `tm-*` frontmatter and to-do checkboxes in item notes (notes with `tm-type`), when you edit them in Taskmaster.
  - New notes and folders in the projects folder (default `Projects/`) when you create items, and renames there when you rename or move them.
  - `_taskmaster/state.json` for priorities, plans, capacity and holidays. If that file can't be read, it is kept as `_taskmaster/state.json.bad` rather than overwritten.
- **What it deletes:** only the notes, and their emptied folders, of items you delete in Taskmaster. Deletes go to Obsidian's trash, so you can restore them, and Ctrl+Z undoes them in the session.
- **Nothing outside the vault.** Taskmaster doesn't touch any files outside your vault.
- **Back up your vault** before trying any plugin that edits notes, this one included.

### Verifying a release

Releases are built by `.github/workflows/release.yml` from the tagged commit, never on a laptop. Each lists SHA-256 checksums. Once the repo is public, each also carries a signed provenance attestation. Check a download with:

```sh
gh attestation verify main.js --repo LSebeke/taskmaster
```

## Develop

| Command | Does |
|---|---|
| `npm test` | Unit and integration tests |
| `npm run typecheck` | TypeScript |
| `npm run build` | Minified `main.js`. Add `-- --dev` for inline source maps |
| `npm run harness` | Drives the view in headless Chromium over a fake vault |
| `npm run perf` | Measures every budget in the spec. Add `-- --ci` for a margin. `CHROMIUM` picks the browser |
| `npm run smoke` | Drives real Obsidian headless on a throwaway vault. Needs `/usr/bin/obsidian`, or set `OBSIDIAN` |

CI (`.github/workflows/ci.yml`) runs all of these except the harness on every PR and every push to `main`: perf with the CI margin, smoke against two pinned Obsidian versions. `.github/workflows/release.yml` turns a version tag into a draft release. `.github/workflows/audit.yml` checks dependencies for known vulnerabilities, registry signatures and new install scripts, also weekly. `.npmrc` turns install scripts off, so `npm install` runs no package code.

## Docs

- [`SPEC.md`](SPEC.md): the behaviour spec.
- [`prototype/taskmaster-prototype.html`](prototype/taskmaster-prototype.html): the original interactive prototype. Open it in a browser.
