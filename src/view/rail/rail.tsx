import type { UiState } from '../ui-state';
import { NewForm } from './new-form';
import { AllProjects, ExternalPanel, Overview, TaskPanel } from './panels';
import type { PanelProps } from './parts';
import { TodoTab } from './todo-tab';

type RailProps = Omit<PanelProps, 'id'> & { ui: UiState; roots: string[] };

function Panel({ st, a, ui, roots, act, readTodos, previewing }: RailProps) {
  const { sel, focus } = ui;
  const common = { st, a, act, readTodos, previewing };
  if (ui.form) return <NewForm st={st} a={a} form={ui.form} act={act} key={ui.form.nonce} />;
  if (sel && st.items[sel].kind === 'ext') return <ExternalPanel {...common} id={sel} key={sel} />;
  if (sel && !a.K[sel]) return <TaskPanel {...common} id={sel} key={sel} />;
  const id = sel ?? focus;
  if (!id) return <AllProjects st={st} a={a} act={act} roots={roots} />;
  return <Overview {...common} id={id} key={id} selected={!!sel} focused={focus === id} />;
}

export function Rail(props: RailProps) {
  const { ui, act } = props;
  const todo = ui.tab === 'todo';
  return (
    <>
      <div class="tm-tabs">
        <button class={`tm-tab${todo ? '' : ' tm-on'}`} onClick={() => act.ui({ tab: 'overview' })}>
          {ui.form ? 'Add' : ui.sel ? 'Details' : 'Overview'}
        </button>
        <button class={`tm-tab${todo ? ' tm-on' : ''}`} onClick={() => act.ui({ tab: 'todo' })}>
          To-do
        </button>
      </div>
      <div class="tm-panel" key={ui.tab}>
        {todo ? <TodoTab {...props} /> : <Panel {...props} />}
      </div>
    </>
  );
}
