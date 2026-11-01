import type { UiState } from '../ui-state';
import { AllProjects, ExternalPanel, Overview, TaskPanel } from './panels';
import type { PanelProps } from './parts';

type RailProps = Omit<PanelProps, 'id'> & { ui: UiState; roots: string[] };

function Panel({ st, a, ui, roots, act, readTodos }: RailProps) {
  const { sel, focus } = ui;
  const common = { st, a, act, readTodos };
  if (sel && st.items[sel].kind === 'ext') return <ExternalPanel {...common} id={sel} />;
  if (sel && !a.K[sel]) return <TaskPanel {...common} id={sel} />;
  const id = sel ?? focus;
  if (!id) return <AllProjects st={st} a={a} act={act} roots={roots} />;
  return <Overview {...common} id={id} selected={!!sel} focused={focus === id} />;
}

export function Rail(props: RailProps) {
  return (
    <>
      <div class="tm-tabs">
        <span class="tm-tab">{props.ui.sel ? 'Details' : 'Overview'}</span>
      </div>
      <div class="tm-panel">
        <Panel {...props} />
      </div>
    </>
  );
}
