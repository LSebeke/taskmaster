import type { Analysis, State } from '../engine';
import { hiddenList } from './rows';
import { EYE, EYE_OFF } from './hierarchy';
import { ZOOMS, layers, type Axis, type UiState } from './ui-state';

export interface TopBarProps {
  st: State;
  ui: UiState;
  onUp(): void;
  onFocus(id: string | null): void;
  onZoom(ppd: number): void;
  onAxis(axis: Axis): void;
}

export function TopBar({ st, ui, onUp, onFocus, onZoom, onAxis }: TopBarProps) {
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
      {show.today && (
        <span>
          {swatch('var(--tm-accent)', 2, 13, 0)}
          today
        </span>
      )}
      <span class="tm-hint">Click: select. ⤢ Focus: zoom chart. Double-click: open note. Ctrl+wheel: zoom. Esc: up.</span>
    </>
  );
}

export function StatusBar({ st, a, message }: { st: State; a: Analysis; message: string }) {
  const n = a.conflicts.length;
  return (
    <>
      <span class="tm-changes">{message}</span>
      {n > 0 && (
        <span class="tm-tone-crit">
          ⚠ {n} conflict{n > 1 ? 's' : ''}
        </span>
      )}
      <span>{st.settings.weekly} h/week</span>
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

export function TreeFoot({ st, roots }: { st: State; roots: string[] }) {
  return (
    <>
      <b>Weekly load</b>
      <div class="tm-sub tm-small">Line: capacity. Labelled weeks are overrides.</div>
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
