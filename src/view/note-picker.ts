import { FuzzySuggestModal, type App, type FuzzyMatch, type TFile } from 'obsidian';

/** A note chosen, or a name to create one with. */
export type NotePick = { path: string } | { create: string };

type Choice = TFile | { create: string };

/** Obsidian's fuzzy picker over the vault's notes. A query nothing matches is offered as a new note. */
export class NotePicker extends FuzzySuggestModal<Choice> {
  constructor(
    app: App,
    private done: (pick: NotePick) => void,
  ) {
    super(app);
    this.setPlaceholder('Link a note…');
  }

  getItems(): Choice[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(item: Choice): string {
    return 'create' in item ? `Create "${item.create}"` : item.path;
  }

  override getSuggestions(query: string): FuzzyMatch<Choice>[] {
    const found = super.getSuggestions(query);
    const name = query.trim();
    return found.length || !name ? found : [{ item: { create: name }, match: { score: 0, matches: [] } }];
  }

  onChooseItem(item: Choice): void {
    this.done('create' in item ? item : { path: item.path });
  }
}
