import { isoWeekKey, type Analysis, type State } from '../engine';
import { NumField } from './rail/fields';
import { hiddenList } from './rows';
import { EYE, EYE_OFF } from './hierarchy';
import { VIEW_TOGGLES } from './view-menu-items';
import { ZOOMS, layers, type Axis, type LayerLevel, type LayerName, type Show, type UiState } from './ui-state';

export interface TopBarProps {
  st: State;
  ui: UiState;
  onUp(): void;
  onFocus(id: string | null): void;
  onZoom(ppd: number): void;
  onAxis(axis: Axis): void;
  onLayer(layer: LayerName, level: LayerLevel): void;
  onView: ViewMenuActions & { toggle(): void };
  planName: string;
  canPlan: boolean;
  onPlan(): void;
  undoLabel: string | null;
  onUndo(): void;
}

const LEVELS: { level: LayerLevel; label: string }[] = [
  { level: 'off', label: 'Off' },
  { level: 'ghost', label: 'Ghost' },
  { level: 'solid', label: 'Solid' },
];

function LayerSeg({ name, level, onPick }: { name: string; level: LayerLevel; onPick(level: LayerLevel): void }) {
  return (
    <span class="tm-seg" role="group" aria-label={`${name} visibility`}>
      <span>{name}</span>
      {LEVELS.map(l => (
        <button class={l.level === level ? 'tm-on' : ''} onClick={() => onPick(l.level)}>
          {l.label}
        </button>
      ))}
    </span>
  );
}

export interface ViewMenuActions {
  set(key: keyof Show, on: boolean): void;
  clean(): void;
  reset(): void;
}

function ViewMenu({ show, on }: { show: Show; on: ViewMenuActions }) {
  return (
    <div class="tm-view-menu">
      <div class="tm-actions">
        <button onClick={on.clean}>Clean for sharing</button>
        <button onClick={on.reset}>Default</button>
      </div>
      {VIEW_TOGGLES.map(t => (
        <label key={t.key}>
          <input type="checkbox" checked={show[t.key]} onChange={e => on.set(t.key, e.currentTarget.checked)} /> {t.label}
        </label>
      ))}
    </div>
  );
}

export function TopBar({ st, ui, onUp, onFocus, onZoom, onAxis, onLayer, onView, planName, canPlan, onPlan, undoLabel, onUndo }: TopBarProps) {
  const path: string[] = [];
  for (let i = ui.focus; i; i = st.items[i].parent) path.unshift(i);
  return (
    <>
      <button class="tm-up tm-big" disabled={!ui.focus} title="Go up one level (Esc)" onClick={onUp}>
        ↑ Up
      </button>
      <div class="tm-crumbs">
        <a onClick={() => onFocus(null)}>All projects</a>
        {path.map((id, n) => (
          <>
            {' › '}
            {n === path.length - 1 ? <span>{st.items[id].title}</span> : <a onClick={() => onFocus(id)}>{st.items[id].title}</a>}
          </>
        ))}
      </div>
      <div class="tm-spacer" />
      <LayerSeg name="Plan" level={ui.plan} onPick={level => onLayer('plan', level)} />
      <LayerSeg name="Forecast" level={ui.fc} onPick={level => onLayer('fc', level)} />
      <span class="tm-seg">
        <span>Zoom</span>
        {ZOOMS.map(z => (
          <button class={z.ppd === ui.ppd ? 'tm-on' : ''} onClick={() => onZoom(z.ppd)}>
            {z.label}
          </button>
        ))}
      </span>
      <span class="tm-seg">
        <span>Axis</span>
        <button class={ui.axis === 'date' ? 'tm-on' : ''} onClick={() => onAxis('date')}>
          Date
        </button>
        <button class={ui.axis === 'cw' ? 'tm-on' : ''} onClick={() => onAxis('cw')}>
          CW
        </button>
      </span>
      <span class="tm-view-wrap">
        <button class="tm-view-btn" aria-expanded={ui.viewOpen} onClick={onView.toggle}>
          View ▾
        </button>
        {ui.viewOpen && <ViewMenu show={ui.show} on={onView} />}
      </span>
      <button class="tm-plan-btn" disabled={!canPlan} title={`Update plan: ${planName}`} onClick={onPlan}>
        Update plan: {planName}
      </button>
      <button class="tm-undo" disabled={!undoLabel} title={undoLabel ? `Undo: ${undoLabel} (Ctrl+Z)` : 'Nothing to undo'} onClick={onUndo}>
        Undo
      </button>
    </>
  );
}

export function Legend({ st, a, ui }: { st: State; a: Analysis; ui: UiState }) {
  const { show } = ui;
  const { ghost } = layers(ui);
  const swatch = (background: string, width: number, height: number, borderRadius = 2) => <i style={{ background, width: `${width}px`, height: `${height}px`, borderRadius: `${borderRadius}px` }} />;
  const hasExt = (a.K[''] ?? []).some(i => st.items[i].kind === 'ext');
  return (
    <>
      <span>
        <i class="tm-swatch-fill" />
        complete / remaining
      </span>
      {ghost && (
        <span>
          {swatch('var(--tm-muted)', 26, 4)}
          {ghost === 'plan' ? 'plan' : 'forecast'} (ghost)
        </span>
      )}
      {show.ext && hasExt && (
        <span>
          {swatch('var(--tm-ink2)', 18, 10, 3)}
          external
        </span>
      )}
      {show.pins && (
        <span>
          {swatch('var(--tm-ink)', 7, 7, 0)}
          pinned edge
        </span>
      )}
      {show.crit && (
        <span>
          {swatch('var(--tm-crit)', 18, 2, 0)}
          critical chain
        </span>
      )}
      {show.cap && (
        <span>
          <i class="tm-swatch-cap" />
          waiting for capacity
        </span>
      )}
      {show.today && (
        <span>
          {swatch('var(--tm-accent)', 2, 13, 0)}
          today
        </span>
      )}
      <span class="tm-hint">Click: select. ⤢ Focus: zoom chart. Drag forecast bar: pin. Drag the dot: add dependency. Double-click: open note. Ctrl+wheel: zoom. Esc: up.</span>
    </>
  );
}

export function StatusBar({ st, a, message, onCapacity }: { st: State; a: Analysis; message: string; onCapacity(hours: number): void }) {
  const n = a.conflicts.length;
  return (
    <>
      <span class="tm-changes">{message}</span>
      {n > 0 && (
        <span class="tm-tone-crit">
          ⚠ {n} conflict{n > 1 ? 's' : ''}
        </span>
      )}
      <label class="tm-cap">
        <NumField class="tm-cap-in" label="Weekly capacity" value={st.settings.weekly} min={1} step={1} onCommit={h => h != null && onCapacity(h)} /> h/week
      </label>
    </>
  );
}

export interface TreeHeadProps {
  st: State;
  ui: UiState;
  onToggleList(): void;
  onRestore(id: string): void;
}

export function TreeHead({ st, ui, onToggleList, onRestore }: TreeHeadProps) {
  const hidden = hiddenList(st, ui.hidden);
  return (
    <>
      <button class="tm-eye tm-hidden-btn" title="List hidden rows so they can be restored" onClick={onToggleList}>
        <span dangerouslySetInnerHTML={{ __html: hidden.length ? EYE_OFF : EYE }} />
        {hidden.length > 0 && `${hidden.length} hidden`}
      </button>
      <b>Work</b>
      <span class="tm-head-n">Done</span>
      <span class="tm-head-s">vs plan</span>
      {ui.hiddenOpen && (
        <div class="tm-hidden-list">
          {hidden.length === 0 && <div class="tm-sub">Nothing is hidden</div>}
          {hidden.map(h => (
            <div class="tm-li" key={h.id}>
              <span class="tm-grow">
                {h.title}
                {h.path && <div class="tm-sub tm-small">{h.path}</div>}
              </span>
              <button title="Show on chart" onClick={() => onRestore(h.id)}>
                Show
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export interface WeekEditProps {
  week: number;
  /** Override, or null. */
  value: number | null;
  /** Hours the week follows without one. */
  weekly: number;
  left: number;
  onCommit(hours: number | null): void;
}

/** Edits one week's capacity over the load strip. Clearing the field removes the override. */
export function WeekEdit({ week, value, weekly, left, onCommit }: WeekEditProps) {
  return (
    <div class="tm-week-edit" style={{ left: `${left}px` }}>
      <span>CW{isoWeekKey(week).slice(-2)}</span>
      <NumField autoFocus clearable label="Hours this week" value={value} step={1} placeholder={String(weekly)} onCommit={onCommit} /> h
    </div>
  );
}

export function TreeFoot({ st, roots }: { st: State; roots: string[] }) {
  return (
    <>
      <b>Weekly load</b>
      <div class="tm-sub tm-small">Line: capacity. Labelled weeks are overrides. Click a week to edit.</div>
      <div class="tm-foot-roots">
        {roots.map((r, i) => (
          <span class="tm-small" key={r}>
            <span class="tm-dot" style={{ background: `var(--tm-c${(i % 8) + 1})` }} />
            {st.items[r].title}
          </span>
        ))}
      </div>
    </>
  );
}
