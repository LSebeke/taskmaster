import { ItemView, Scope, type WorkspaceLeaf } from 'obsidian';
import { GanttApp, type ViewStore } from './gantt-app';
import { NotePicker } from './note-picker';
import { stopAndAsk } from './timer';

export const VIEW_TYPE = 'taskmaster';

export class TaskmasterView extends ItemView {
  gantt?: GanttApp;

  constructor(
    leaf: WorkspaceLeaf,
    private getStore: () => ViewStore,
  ) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'Taskmaster';
  }

  override getIcon() {
    return 'gantt-chart';
  }

  override async onOpen() {
    this.contentEl.classList.add('tm-content');
    const store = this.getStore();
    const gantt = new GanttApp(this.contentEl, store, {
      openNote: path => void this.app.workspace.openLinkText(path, ''),
      pickNote: done => new NotePicker(this.app, done).open(),
      stopTimer: () => stopAndAsk(this.app, store),
    });
    this.gantt = gantt;
    this.scope = new Scope(this.app.scope);
    this.scope.register([], 'Escape', () => {
      gantt.escape();
      return false;
    });
    this.scope.register([], 'n', () => {
      if (this.contentEl.ownerDocument.activeElement?.closest('input,select,textarea')) return true;
      gantt.addItem();
      return false;
    });
    this.scope.register(['Mod'], 'z', () => {
      // Inside a field, Ctrl+Z belongs to the field.
      if (this.contentEl.ownerDocument.activeElement?.closest('input,select,textarea')) return true;
      gantt.undo();
      return false;
    });
    this.registerEvent(this.app.workspace.on('css-change', () => gantt.refreshTheme()));
  }

  override async onClose() {
    this.gantt?.destroy();
    this.gantt = undefined;
  }
}
