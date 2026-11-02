# Taskmaster

Gantt-first project management for a solo engineer, as a desktop Obsidian plugin. Tracks hours against plan, forecasts finish dates from your real capacity, finds the critical chain, and tells you when to cut scope. Your notes are the data: one note per item, with `tm-*` frontmatter.

## Install

```sh
npm ci
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` to `<vault>/.obsidian/plugins/taskmaster/`, then enable Taskmaster under Community plugins. Run the `Open Taskmaster` command. Requires Obsidian 1.7.2 or later.

## Develop

| Command | Does |
|---|---|
| `npm test` | Unit and integration tests |
| `npm run typecheck` | TypeScript |
| `npm run build` | Minified `main.js`. Add `-- --dev` for inline source maps |
| `npm run harness` | Drives the view in headless Chromium over a fake vault |
| `npm run perf` | Measures every budget in the spec. Add `-- --ci` for a margin |
| `npm run smoke` | Drives real Obsidian headless on a throwaway vault. Needs `/usr/bin/obsidian` |

## Docs

- [`SPEC.md`](SPEC.md): the behaviour spec.
- [`prototype/taskmaster-prototype.html`](prototype/taskmaster-prototype.html): the original interactive prototype. Open it in a browser.
