import { build } from 'esbuild';

const dev = process.argv.includes('--dev');

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
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'info',
});
