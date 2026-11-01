import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { iso, type Analysis, type State } from '../engine';
import { fmtD } from './format';
import { historyView, planRows } from './plan-ui';
import type { PlanDialog } from './ui-state';

/** Over the whole view, not in the rail: the top bar's button has to work with the rail hidden. */
function Shell({ label, onClose, children }: { label: string; onClose(): void; children: ComponentChildren }) {
  return (
    <div class="tm-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div class="tm-dialog" role="dialog" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

export interface PlanDialogProps {
  st: State;
  a: Analysis;
  dlg: PlanDialog;
  onToggle(id: string): void;
  onDeep(deep: boolean): void;
  onApply(): void;
  onCancel(): void;
  onHistory(): void;
}

export function PlanDialogBox({ st, a, dlg, onToggle, onDeep, onApply, onCancel, onHistory }: PlanDialogProps) {
  const rows = planRows(st, a, dlg);
  const count = rows.filter(r => r.checked && r.plannable).length;
  const above = dlg.above ? st.items[dlg.above]?.title : null;
  const apply = useRef<HTMLButtonElement>(null);
  useEffect(() => apply.current?.focus(), []);
  return (
    <Shell label="Update plan" onClose={onCancel}>
      <h2>Update plan: {dlg.name}</h2>
      <div class="tm-sub">
        Chosen rows take the current forecast as their plan.
        {above && (
          <>
            {' '}
            <b>{above}</b> and everything above stays as it is.
          </>
        )}
      </div>
      <div class="tm-dlg-rows">
        {rows.map(r => (
          <div class="tm-li" key={r.id}>
            <label class="tm-grow">
              <input type="checkbox" checked={r.checked} disabled={!r.plannable} onChange={() => onToggle(r.id)} /> {r.title}
            </label>
            <span class="tm-num">{r.plannable ? `${fmtD(r.oldEnd)} → ${fmtD(r.newEnd)}` : 'no dates'}</span>
          </div>
        ))}
      </div>
      {rows.some(r => r.group) && (
        <label class="tm-dlg-deep">
          <input type="checkbox" checked={dlg.deep} onChange={e => onDeep(e.currentTarget.checked)} /> Also update their sub-levels
        </label>
      )}
      <div class="tm-actions">
        <button ref={apply} class="tm-primary" disabled={!count} onClick={onApply}>
          Apply to {count} row{count === 1 ? '' : 's'}
        </button>
        <button onClick={onCancel}>Cancel</button>
        <span class="tm-grow" />
        <button onClick={onHistory}>History ({st.planHistory?.length ?? 0})</button>
      </div>
    </Shell>
  );
}

export function HistoryDialog({ st, onClose }: { st: State; onClose(): void }) {
  const entries = historyView(st);
  const [open, setOpen] = useState(0);
  return (
    <Shell label="Plan history" onClose={onClose}>
      <h2>Plan history</h2>
      <div class="tm-sub">Each update, newest first, with the end it replaced and the end it set.</div>
      <div class="tm-dlg-rows">
        {entries.length === 0 && <div class="tm-sub">No updates yet.</div>}
        {entries.map((e, i) => (
          <div key={i}>
            <button class="tm-dlg-entry" aria-expanded={i === open} onClick={() => setOpen(i === open ? -1 : i)}>
              {i === open ? '▾' : '▸'} {iso(e.day)}, {e.rows.length} item{e.rows.length === 1 ? '' : 's'}
            </button>
            {i === open &&
              e.rows.map(r => (
                <div class="tm-li tm-dlg-sub" key={r.id}>
                  <span class="tm-grow">{r.title}</span>
                  <span class="tm-num">
                    {fmtD(r.before?.end)} → {fmtD(r.after?.end)}
                  </span>
                </div>
              ))}
          </div>
        ))}
      </div>
      <div class="tm-actions">
        <button onClick={onClose}>Close</button>
      </div>
    </Shell>
  );
}
