import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { dayOf, iso, type Day } from '../../engine';
import { addDep, logHours, removeDep, type Edit } from '../../store/edits';
import { depChoices } from '../deps';
import { fmtH } from '../format';
import { Dated, Link, type PanelProps } from './parts';

const text = (v: number | null | undefined) => (v == null ? '' : fmtH(v));

interface NumProps {
  value: number | null | undefined;
  /** Null: the field was cleared. */
  onCommit(v: number | null): void;
  /** Whether a cleared field means something. Otherwise it goes back. */
  clearable?: boolean;
  min?: number;
  step?: number;
  class?: string;
  label?: string;
  placeholder?: string;
  autoFocus?: boolean;
}

/** Commits on Enter or leaving the field. Keeps what is being typed through re-renders. */
export function NumField({ value, onCommit, clearable, min = 0, step = 0.5, class: cls, label, placeholder, autoFocus }: NumProps) {
  /** What is being typed. Null: the field shows `value`. */
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (autoFocus) ref.current?.select();
  }, []);
  const commit = () => {
    setDraft(null);
    const typed = ref.current!.value.trim();
    if (typed === text(value)) return;
    const n = Number(typed);
    if (typed === '' ? !clearable : !Number.isFinite(n) || n < min) return;
    onCommit(typed === '' ? null : n);
  };
  return (
    <input
      ref={ref}
      type="number"
      class={`tm-num-in ${cls ?? ''}`}
      min={min}
      step={step}
      aria-label={label}
      placeholder={placeholder}
      value={draft ?? text(value)}
      onInput={e => setDraft(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

/** A date, committed when the input settles on one. */
export function DateField({ value, onCommit, label }: { value: Day | null | undefined; onCommit(d: Day | null): void; label?: string }) {
  return (
    <input
      type="date"
      class="tm-date-in"
      aria-label={label}
      value={value != null ? iso(value) : ''}
      onChange={e => {
        const v = e.currentTarget.value;
        onCommit(v ? dayOf(v) : null);
      }}
    />
  );
}

interface EdgeProps {
  name: string;
  pin: Day | null | undefined;
  /** Where the schedule puts the edge, and so the date a new pin starts from. */
  auto: Day | null;
  today: Day;
  onPin(d: Day | null): void;
}

/** One edge's Auto/Pinned switch. */
export function EdgeSwitch({ name, pin, auto, today, onPin }: EdgeProps) {
  const pinned = pin != null;
  return (
    <span class="tm-edge">
      <span class="tm-seg" role="group" aria-label={`${name} edge`}>
        <button class={pinned ? '' : 'tm-on'} onClick={() => pinned && onPin(null)}>
          Auto
        </button>
        <button class={pinned ? 'tm-on' : ''} onClick={() => !pinned && onPin(auto ?? today)}>
          Pinned
        </button>
      </span>
      {pinned ? <DateField value={pin} label={`${name} pin`} onCommit={d => d != null && onPin(d)} /> : <Dated d={auto} />}
    </span>
  );
}

export function LogRow({ id, today, apply }: { id: string; today: Day; apply(e: Edit): void }) {
  const [hours, setHours] = useState('1');
  const [day, setDay] = useState(iso(today));
  const submit = () => {
    const h = Number(hours);
    if (h > 0 && day) apply(logHours(id, dayOf(day), h));
  };
  return (
    <div class="tm-log-form">
      <input type="number" class="tm-num-in" aria-label="Hours to log" min="0.25" step="0.25" value={hours} onInput={e => setHours(e.currentTarget.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
      <input type="date" class="tm-date-in" aria-label="Log date" value={day} onInput={e => setDay(e.currentTarget.value)} />
      <button onClick={submit}>Log</button>
    </div>
  );
}

/** An item's dependencies, with the picker. The candidates are costly, so a live drag keeps the last list. */
export function Deps({ st, a, id, act, previewing }: Omit<PanelProps, 'readTodos'>) {
  const it = st.items[id];
  const groups = useMemo(() => depChoices(st, id), [id, previewing ? null : st.items]);
  return (
    <>
      {(it.deps ?? []).map(d => (
        <div class="tm-li" key={d}>
          <Link id={d} st={st} act={act} />
          <Dated d={a.results[d]?.end} />
          <button class="tm-x-btn" title="Remove dependency" aria-label={`Remove dependency on ${st.items[d]?.title ?? d}`} onClick={() => act.apply(removeDep(id, d))}>
            ×
          </button>
        </div>
      ))}
      {!it.deps?.length && <div class="tm-sub">Nothing</div>}
      <select
        class="tm-dep-pick"
        aria-label="Add dependency"
        value=""
        onChange={e => {
          const dep = e.currentTarget.value;
          e.currentTarget.value = '';
          if (dep) act.apply(addDep(id, dep));
        }}
      >
        <option value="">+ Add dependency…</option>
        {groups.map(g => (
          <optgroup label={g.path} key={g.path}>
            {g.items.map(c => (
              <option value={c.id} key={c.id}>
                {c.title}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </>
  );
}
