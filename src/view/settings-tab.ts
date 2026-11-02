import { Notice, PluginSettingTab, Setting, type App, type Plugin, type TextComponent } from 'obsidian';
import { dayOf, iso, isoWeekKey, weekOfIsoKey, weekStart, type Day } from '../engine';
import { addHoliday, removeHoliday, setStaleDays, setWeekCapacity, setWeekly, type Edit } from '../store/edits';
import { fmtD, h1 } from './format';

/** What the tab needs of the store. */
export interface SettingsStore {
  readonly state: { settings: { weekly: number; weekCap?: Record<number, number>; staleDays: number; holidays: Day[] } };
  readonly projectsFolder: string;
  apply(edit: Edit): boolean;
  setProjectsFolder(path: string): string | null;
}

/** Commits on leaving the field, not per keystroke, so one change makes one undo step. */
function onCommit(text: TextComponent, commit: (value: string) => void) {
  text.inputEl.addEventListener('change', () => commit(text.getValue().trim()));
}

/** Capacity, week overrides, holidays, stale days and the projects folder. All of it lands in state.json, and undoes. */
export class TaskmasterSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private getStore: () => SettingsStore,
  ) {
    super(app, plugin);
  }

  private get store() {
    return this.getStore();
  }

  private number(setting: Setting, value: number, commit: (n: number) => boolean) {
    setting.addText(text => {
      text.inputEl.type = 'number';
      text.setValue(String(value));
      onCommit(text, v => {
        // A refused value leaves the field showing the old one.
        if (v === '' || !commit(Number(v))) text.setValue(String(value));
        else this.display();
      });
    });
  }

  override display(): void {
    const { containerEl: el } = this;
    const { settings } = this.store.state;
    el.empty();

    this.number(new Setting(el).setName('Weekly capacity').setDesc('Hours per week, spread evenly across working days.'), settings.weekly, h => this.store.apply(setWeekly(h)));
    this.number(new Setting(el).setName('Stale after').setDesc('Days an in-progress task can go without an update to its hours left.'), settings.staleDays, d => this.store.apply(setStaleDays(d)));
    new Setting(el)
      .setName('Projects folder')
      .setDesc('Items are read from here, and new ones created here. Existing notes stay where they are, so items outside it leave the chart and their priority levels.')
      .addText(text => {
        text.setValue(this.store.projectsFolder);
        onCommit(text, v => {
          const refused = this.store.setProjectsFolder(v);
          if (refused) new Notice(refused);
          this.display();
        });
      });

    new Setting(el).setName('Week overrides').setDesc('Hours for one full week, in place of the weekly capacity.').setHeading();
    for (const [week, hours] of Object.entries(settings.weekCap ?? {}).sort(([a], [b]) => Number(a) - Number(b))) this.overrideRow(Number(week), hours);
    this.addOverride();

    new Setting(el).setName('Holidays').setDesc('Days without capacity.').setHeading();
    for (const day of settings.holidays) this.holidayRow(day);
    this.addHoliday();
  }

  private removable(setting: Setting, label: string, edit: Edit) {
    setting.addExtraButton(b =>
      b
        .setIcon('x')
        .setTooltip(label)
        .onClick(() => {
          this.store.apply(edit);
          this.display();
        }),
    );
  }

  private overrideRow(week: number, hours: number) {
    const setting = new Setting(this.containerEl).setName(isoWeekKey(week)).setDesc(`Week of ${fmtD(weekStart(week))}: ${h1(hours)}h`);
    this.removable(setting, 'Remove', setWeekCapacity(week, null));
  }

  private addOverride() {
    let week: TextComponent;
    let hours: TextComponent;
    new Setting(this.containerEl)
      .setName('Add a week')
      .addText(t => {
        week = t;
        t.inputEl.type = 'week';
      })
      .addText(t => {
        hours = t;
        t.inputEl.type = 'number';
        t.inputEl.min = '0';
        t.setPlaceholder('Hours');
      })
      .addButton(b =>
        b.setButtonText('Add').onClick(() => {
          const w = weekOfIsoKey(week.getValue());
          const h = Number(hours.getValue());
          if (w === undefined || hours.getValue() === '' || !(h >= 0)) return void new Notice('Give a week and its hours.');
          this.store.apply(setWeekCapacity(w, h));
          this.display();
        }),
      );
  }

  private holidayRow(day: Day) {
    this.removable(new Setting(this.containerEl).setName(iso(day)).setDesc(fmtD(day)), 'Remove', removeHoliday(day));
  }

  private addHoliday() {
    let date: TextComponent;
    new Setting(this.containerEl)
      .setName('Add a holiday')
      .addText(t => {
        date = t;
        t.inputEl.type = 'date';
      })
      .addButton(b =>
        b.setButtonText('Add').onClick(() => {
          if (!date.getValue()) return void new Notice('Give a date.');
          this.store.apply(addHoliday(dayOf(date.getValue())));
          this.display();
        }),
      );
  }
}
