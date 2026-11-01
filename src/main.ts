import { Plugin } from 'obsidian';
import { TaskmasterStore } from './store';

export default class TaskmasterPlugin extends Plugin {
  store?: TaskmasterStore;

  /** Budget: 5 ms. Everything real waits for the layout. */
  override onload(): void {
    this.app.workspace.onLayoutReady(() => {
      const store = new TaskmasterStore(this.app);
      this.store = store;
      this.register(() => store.dispose());
      void store.load();
    });
  }
}
