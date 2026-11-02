import { Notice, type App } from 'obsidian';
import { takesHours } from '../store/edits';
import type { ViewStore } from './gantt-app';
import { LogHoursModal } from './prompts';
import { stopAndAsk } from './timer';
import { TaskmasterView } from './taskmaster-view';

export interface CommandHost {
  app: App;
  store(): ViewStore;
  /** Opens or reveals the view. */
  view(): Promise<TaskmasterView>;
}

export interface Command {
  id: string;
  name: string;
  run(): void | Promise<void>;
}

/** What a command acts on: the task selected in the view while it has focus, else the note open. */
function current(h: CommandHost): string | null {
  const selected = h.app.workspace.getActiveViewOfType(TaskmasterView)?.gantt?.selected;
  return selected ?? h.app.workspace.getActiveFile()?.path ?? null;
}

const NO_TASK = 'Open a task, or select one in Taskmaster.';

function toggleTimer(h: CommandHost) {
  const store = h.store();
  if (store.timer) return stopAndAsk(h.app, store);
  const id = current(h);
  if (!id || !store.startTimer(id)) new Notice(`${NO_TASK} It needs hours left.`);
}

function askLog(h: CommandHost) {
  const store = h.store();
  const st = store.state;
  const id = current(h);
  if (id && takesHours(st, id)) new LogHoursModal(h.app, store, id).open();
  else new Notice(NO_TASK);
}

async function newTask(h: CommandHost) {
  const id = h.app.workspace.getActiveFile()?.path;
  const it = id ? h.store().state.items[id] : undefined;
  if (!id || !it) return void new Notice('This note is not a Taskmaster item.');
  if (it.kind !== 'item') return void new Notice('Milestones and external items cannot have children.');
  (await h.view()).gantt?.newUnder(id);
}

export const commands = (h: CommandHost): Command[] => [
  { id: 'open', name: 'Open Taskmaster', run: () => h.view().then(() => undefined) },
  { id: 'new-project', name: 'New project', run: async () => (await h.view()).gantt?.newProject() },
  { id: 'new-task', name: 'New task under current note', run: () => newTask(h) },
  { id: 'toggle-timer', name: 'Start/stop timer', run: () => toggleTimer(h) },
  { id: 'log-hours', name: 'Log hours', run: () => askLog(h) },
];
