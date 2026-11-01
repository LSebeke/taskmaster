import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  outfile: 'main.js',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  sourcemap: 'inline',
  logLevel: 'info',
});
