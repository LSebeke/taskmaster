import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Analysis, State, Todo } from '../../engine';
import type { Edit } from '../../store/edits';
import { fmtD, h1, noteName } from '../format';
import { statusOf } from '../explain';
import type { UiState } from '../ui-state';

export interface RailActions {
  select(id: string | null): void;
  focus(id: string): void;
  openNote(path: string): void;
  apply(edit: Edit): void;
  /** Update plan, for the same target as the top bar's button. */
  openPlan(): void;
  openHistory(): void;
  setTodoDone(id: string, index: number, t: string, done: boolean): void;
  addTodo(id: string, text: string): void;
  ui(patch: Partial<UiState>): void;
}

export interface PanelProps {
  st: State;
  a: Analysis;
  id: string;
  act: RailActions;
  readTodos(id: string): Promise<Todo[]>;
  /** A drag is showing a schedule that is not stored. */
  previewing: boolean;
}

export const Card = ({ tone, children }: { tone?: string; children: ComponentChildren }) => <div class={`tm-card${tone ? ` tm-card-${tone}` : ''}`}>{children}</div>;

export function StatusCard({ st, a, id }: { st: State; a: Analysis; id: string }) {
  const s = statusOf(st, a, id);
  return (
    <Card tone={s.tone}>
      <b>{s.title}</b>
      {s.sub && <div class="tm-sub">{s.sub}</div>}
    </Card>
  );
}

export function Tiles({ st, a, id }: { st: State; a: Analysis; id: string }) {
  const b = a.by[id];
  const it = st.items[id];
  const should = b.shouldPct == null ? null : Math.round(b.shouldPct * 100);
  const budget = it.budget ?? st.plan[id]?.hours;
  const total = b.spent + b.left;
  const over = !!budget && total > budget;
  return (
    <div class="tm-tiles">
      <div class="tm-tile">
        <b>{h1(b.left)}h</b>
        <small>hours left</small>
      </div>
      <div class="tm-tile">
        <b>{Math.round(b.pct * 100)}%</b>
        <small>done{should != null && `, plan says ${should}% today`}</small>
      </div>
      <div class="tm-tile">
        <b>{h1(b.spent)}h</b>
        <small>spent{!!budget && ` of ${h1(budget)}h ${it.budget ? 'budget' : 'plan'}`}</small>
      </div>
      <div class="tm-tile">
        <b class={over ? 'tm-tone-crit' : ''}>
          {over && '▲ '}
          {h1(total)}h
        </b>
        <small>
          projected total{!!budget && ` (${over ? '+' : ''}${h1(total - budget)}h)`}
        </small>
      </div>
    </div>
  );
}

export const Field = ({ label, children }: { label: string; children: ComponentChildren }) => (
  <div class="tm-field">
    <label>{label}</label>
    <span>{children}</span>
  </div>
);

export const Link = ({ id, st, act }: { id: string; st: State; act: RailActions }) => (
  <span class="tm-grow tm-link" onClick={() => act.select(id)}>
    {st.items[id]?.title ?? id}
  </span>
);

export function Notes({ st, id, act }: Pick<PanelProps, 'st' | 'id' | 'act'>) {
  const notes = st.items[id].notes ?? [];
  if (!notes.length) return <div class="tm-sub">None</div>;
  return (
    <>
      {notes.map(n => (
        <div class="tm-li" key={n}>
          <span class="tm-grow tm-link tm-note" onClick={() => act.openNote(n)}>
            [[{noteName(n)}]]
          </span>
        </div>
      ))}
    </>
  );
}

function AddTodo({ id, act }: Pick<PanelProps, 'id' | 'act'>) {
  const field = useRef<HTMLInputElement>(null);
  const commit = () => {
    const input = field.current!;
    if (input.value.trim()) act.addTodo(id, input.value);
    input.value = '';
  };
  return <input ref={field} class="tm-todo-add" aria-label="Add to-do" placeholder="Add to-do…" onBlur={commit} onKeyDown={e => e.key === 'Enter' && commit()} />;
}

/** Text lives in the note, not the cache, so it loads on demand. Ticks come from the state, which has them at once. */
export function Todos({ st, a, id, act, readTodos, previewing }: PanelProps) {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  useEffect(() => {
    let live = true;
    readTodos(id).then(
      t => live && setTodos(t),
      () => live && setTodos([]),
    );
    return () => {
      live = false;
    };
  }, [id, previewing ? null : a]);
  if (!todos) return null;
  const known = st.items[id].todos;
  const shown = known?.length === todos.length ? todos.map((t, i) => ({ ...t, done: known[i].done })) : todos;
  return (
    <ul class="tm-todos">
      {shown.map((t, i) => (
        <li key={i} class={t.done ? 'tm-x' : ''}>
          <label>
            <input type="checkbox" checked={t.done} onChange={e => act.setTodoDone(id, i, t.t, e.currentTarget.checked)} />
            <span>{t.t}</span>
          </label>
        </li>
      ))}
      <li>
        <AddTodo id={id} act={act} />
      </li>
    </ul>
  );
}

export const Dated = ({ d }: { d: number | null | undefined }) => <span class="tm-num">{fmtD(d)}</span>;
