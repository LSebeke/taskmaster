import { ItemView, Scope, type WorkspaceLeaf } from 'obsidian';
import { GanttApp, type ViewStore } from './gantt-app';

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
    const gantt = new GanttApp(this.contentEl, this.getStore(), {
      openNote: path => void this.app.workspace.openLinkText(path, ''),
    });
    this.gantt = gantt;
    this.scope = new Scope(this.app.scope);
    this.scope.register([], 'Escape', () => {
      gantt.escape();
      return false;
    });
    this.registerEvent(this.app.workspace.on('css-change', () => gantt.refreshTheme()));
  }

  override async onClose() {
    this.gantt?.destroy();
    this.gantt = undefined;
  }
}
