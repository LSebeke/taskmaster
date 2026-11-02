import { Plugin } from 'obsidian';
import { TaskmasterStore } from './store';
import { commands, TaskmasterSettingTab, TaskmasterView, VIEW_TYPE, watchTimer } from './view';

export default class TaskmasterPlugin extends Plugin {
  store?: TaskmasterStore;

  /** Budget: 5 ms. Everything real waits for the layout or the first view. */
  override onload(): void {
    this.registerView(VIEW_TYPE, leaf => new TaskmasterView(leaf, () => this.ensureStore()));
    const host = { app: this.app, store: () => this.ensureStore(), view: () => this.openView() };
    for (const c of commands(host)) this.addCommand({ id: c.id, name: c.name, callback: () => void c.run() });
    this.addSettingTab(new TaskmasterSettingTab(this.app, this, () => this.ensureStore()));
    this.app.workspace.onLayoutReady(() => void this.ensureStore());
  }

  /** A restored view can open before the layout-ready callback runs, so either may come first. */
  private ensureStore(): TaskmasterStore {
    if (this.store) return this.store;
    const store = new TaskmasterStore(this.app);
    this.store = store;
    this.register(() => store.dispose());
    // Before layout-ready the vault can look empty, and an empty vault looks like every task was deleted.
    this.app.workspace.onLayoutReady(() => {
      void store.load();
      // Outside the view too, as the timer's command works with the view closed.
      this.register(watchTimer(this.addStatusBarItem(), store));
    });
    return store;
  }

  private async openView(): Promise<TaskmasterView> {
    const { workspace } = this.app;
    const leaf = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
    return leaf.view as TaskmasterView;
  }
}
