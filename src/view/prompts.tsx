import { Modal, type App } from 'obsidian';
import { render, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { dayOf, iso, type Day } from '../engine';
import { logHours, setHoursLeft, type Edit } from '../store/edits';
import { fmtH } from './format';

/** What the prompts need of the store. */
export interface PromptStore {
  readonly state: { items: Record<string, { title: string; left?: number }>; today: Day };
  apply(edit: Edit): boolean;
}

/** One small form in a modal. Opens with the field selected, so typing replaces it. */
abstract class FormModal extends Modal {
  protected abstract title: string;
  protected abstract form(close: () => void): ComponentChildren;

  override onOpen() {
    this.setTitle(this.title);
    render(this.form(() => this.close()), this.contentEl);
  }

  override onClose() {
    render(null, this.contentEl);
  }
}

function Prompt({ children, action, onSubmit }: { children: ComponentChildren; action: string; onSubmit(): void }) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => form.current?.querySelector('input')?.select(), []);
  return (
    <form
      ref={form}
      class="tm-prompt"
      onSubmit={e => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
      <button type="submit" class="mod-cta">
        {action}
      </button>
    </form>
  );
}

function LeftForm({ intro, left, onDone }: { intro: string; left: number; onDone(left: number | null): void }) {
  const [value, setValue] = useState(fmtH(left));
  return (
    <Prompt action="Save" onSubmit={() => onDone(Number(value) >= 0 && value !== '' ? Number(value) : null)}>
      <p>{intro}</p>
      <label>
        Hours left
        <input type="number" min="0" step="0.25" value={value} onInput={e => setValue(e.currentTarget.value)} />
      </label>
    </Prompt>
  );
}

/** After a timer stops. Leaving it alone keeps the hours left the log entry produced. */
export class HoursLeftModal extends FormModal {
  protected title: string;

  constructor(
    app: App,
    private store: PromptStore,
    private stopped: { id: string; hours: number },
  ) {
    super(app);
    this.title = `Hours left on ${store.state.items[stopped.id].title}`;
  }

  protected form(close: () => void) {
    const { id, hours } = this.stopped;
    const it = this.store.state.items[id];
    return (
      <LeftForm
        intro={`Logged ${fmtH(hours)}h on ${it.title}.`}
        left={it.left ?? 0}
        onDone={left => {
          if (left != null) this.store.apply(setHoursLeft(id, left));
          close();
        }}
      />
    );
  }
}

function LogPrompt({ today, onDone }: { today: Day; onDone(hours: number, day: Day): void }) {
  const [hours, setHours] = useState('1');
  const [day, setDay] = useState(iso(today));
  return (
    <Prompt action="Log" onSubmit={() => Number(hours) > 0 && day && onDone(Number(hours), dayOf(day))}>
      <label>
        Hours
        <input type="number" min="0.25" step="0.25" value={hours} onInput={e => setHours(e.currentTarget.value)} />
      </label>
      <label>
        Date
        <input type="date" value={day} onInput={e => setDay(e.currentTarget.value)} />
      </label>
    </Prompt>
  );
}

export class LogHoursModal extends FormModal {
  protected title: string;

  constructor(
    app: App,
    private store: PromptStore,
    private id: string,
  ) {
    super(app);
    this.title = `Log hours on ${store.state.items[id].title}`;
  }

  protected form(close: () => void) {
    return (
      <LogPrompt
        today={this.store.state.today}
        onDone={(hours, day) => {
          this.store.apply(logHours(this.id, day, hours));
          close();
        }}
      />
    );
  }
}
