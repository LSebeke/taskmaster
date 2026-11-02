import TaskmasterPlugin from '../src/main';
import { FakeApp } from './fake-obsidian';

/** Loaded into a fresh page, so `onload` runs cold, as it does when Obsidian starts. */
const evaluated = performance.now();
const plugin = new TaskmasterPlugin(new FakeApp() as never, {} as never);
const t = performance.now();
plugin.onload();
const onload = performance.now() - t;
Object.assign(window, { perfPlugin: { evaluated, onload } });
