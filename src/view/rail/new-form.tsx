import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { dayOf, type Analysis, type Item, type ItemKind, type NewItem, type Scope, type State } from '../../engine';
import { INDENT, newDepChoices, parentChoices } from '../deps';
import { fmtH } from '../format';
import type { FormState } from '../ui-state';
import { Card, Field, type RailActions } from './parts';

const KINDS: [ItemKind, string][] = [
  ['item', 'Item'],
  ['ms', 'Milestone'],
  ['ext', 'External'],
];
const SCOPES: Scope[] = ['must', 'should', 'could'];

const day = (v: string) => (v ? dayOf(v) : undefined);

interface Props {
  st: State;
  a: Analysis;
  form: FormState;
  act: RailActions;
}

function DateInput({ label, value, set }: { label: string; value: string; set(v: string): void }) {
  return (
    <Field label={label}>
      <input type="date" class="tm-date-in" aria-label={label} value={value} onInput={e => set(e.currentTarget.value)} />
    </Field>
  );
}

/** What adding inside `P` does to its hours, if anything. */
function budgetNote(P: Item | null, hasKids: boolean): string | null {
  if (!P || hasKids) return null;
  const hours = (P.spent ?? 0) + (P.left ?? 0);
  if (!(hours > 0)) return null;
  const budget = P.budget == null ? `Adding inside it turns those into its budget, and only the items inside it get scheduled.` : `Only the items inside it get scheduled from now on.`;
  return `${P.title} has ${fmtH(hours)}h. ${budget}`;
}

/** One form for every way of adding. Adding keeps it open for the next item. */
export function NewForm({ st, a, form, act }: Props) {
  const { kind, parent } = form;
  const [title, setTitle] = useState('');
  const [hours, setHours] = useState('');
  const [deadline, setDeadline] = useState('');
  const [scope, setScope] = useState<Scope>('must');
  /** Null: the default level. */
  const [tier, setTier] = useState<number | null>(null);
  const [pinS, setPinS] = useState('');
  const [pinE, setPinE] = useState('');
  const [deps, setDeps] = useState<string[]>([]);
  const [chain, setChain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  useLayoutEffect(() => name.current?.focus(), []);

  const P = parent ? st.items[parent] : null;
  const firstChildLevel = parent && !a.kids[parent] ? st.tiers.findIndex(t => t.includes(parent)) : -1;
  const level = tier ?? (firstChildLevel >= 0 ? firstChildLevel : st.tiers.length - 1);
  const parents = useMemo(() => parentChoices(st, a.kids), [st.items, a]);
  const choices = useMemo(() => newDepChoices(st, parent, deps), [st.items, parent, deps]);
  const last = form.last && st.items[form.last] ? st.items[form.last] : null;
  const convert = budgetNote(P, !!(parent && a.kids[parent]));

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy.current) return;
    busy.current = true;
    const after = chain && form.last && st.items[form.last] && !deps.includes(form.last) ? [...deps, form.last] : deps;
    const n: NewItem =
      kind === 'ext'
        ? { kind, title, pinS: day(pinS), pinE: day(pinE) }
        : kind === 'ms'
          ? { kind, title, parent, pinE: day(pinE), deps: after }
          : { kind, title, parent, hours: hours ? Number(hours) : undefined, deadline: day(deadline), scope, tier: tier ?? undefined, pinS: day(pinS), pinE: day(pinE), deps: after };
    const refused = await act.submit(n);
    busy.current = false;
    setError(refused);
    if (refused) return name.current?.focus();
    setTitle('');
    setHours('');
    setDeadline('');
    setPinS('');
    setPinE('');
    setDeps([]);
    setTier(null);
    name.current?.focus();
  };

  const heading = kind === 'ext' ? 'Add an external item' : parent ? (kind === 'ms' ? 'Add a milestone' : 'Add an item') : 'Add a project';
  const dependsOn = kind !== 'ext' && (
    <>
      <h3>Depends on</h3>
      {deps.map(d => (
        <div class="tm-li" key={d}>
          <span class="tm-grow">{st.items[d]?.title ?? d}</span>
          <button type="button" class="tm-x-btn" aria-label={`Remove dependency on ${st.items[d]?.title ?? d}`} onClick={() => setDeps(deps.filter(x => x !== d))}>
            ×
          </button>
        </div>
      ))}
      <select class="tm-dep-pick" aria-label="Add dependency" value="" onChange={e => setDeps([...deps, e.currentTarget.value])}>
        <option value="">+ Add dependency…</option>
        {choices.map(g => (
          <optgroup label={g.path} key={g.path}>
            {g.items.map(c => (
              <option value={c.id} key={c.id}>
                {c.title}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {last && (
        <label class="tm-chain">
          <input type="checkbox" checked={chain} onChange={e => setChain(e.currentTarget.checked)} /> Also depends on <b>{last.title}</b>, the one just added
        </label>
      )}
    </>
  );

  return (
    <>
      <h2 class="tm-title">{heading}</h2>
      <form autocomplete="off" noValidate onSubmit={submit}>
        <span class="tm-seg tm-kinds">
          {KINDS.map(([k, label]) => (
            <button type="button" class={k === kind ? 'tm-on' : ''} key={k} onClick={() => act.ui({ form: { ...form, kind: k } })}>
              {label}
            </button>
          ))}
        </span>
        <Field label="Name">
          <input ref={name} class="tm-name-in" aria-label="Name" value={title} placeholder={kind === 'ext' ? 'e.g. Machine maintenance' : ''} onInput={e => setTitle(e.currentTarget.value)} />
        </Field>
        {kind === 'ext' ? (
          <>
            <DateInput label="Start" value={pinS} set={setPinS} />
            <DateInput label="End" value={pinE} set={setPinE} />
            <div class="tm-sub tm-small">No hours and no capacity. Link work to it from its details, or by adding it as a dependency.</div>
          </>
        ) : (
          <Field label="Inside">
            <select aria-label="Inside" value={parent ?? ''} onChange={e => act.ui({ form: { ...form, parent: e.currentTarget.value || null } })}>
              <option value="">Top level (project)</option>
              {parents.map(o => (
                <option value={o.id} key={o.id}>
                  {INDENT.repeat(o.depth)}
                  {o.title}
                </option>
              ))}
            </select>
          </Field>
        )}
        {kind !== 'ext' && convert && <Card tone="warn">{convert}</Card>}
        {kind === 'item' && (
          <>
            <Field label="Hours">
              <input type="number" class="tm-num-in" aria-label="Hours" min="0" step="0.25" placeholder="Optional" value={hours} onInput={e => setHours(e.currentTarget.value)} />
            </Field>
            <DateInput label="Deadline" value={deadline} set={setDeadline} />
            <Field label="Scope">
              <select aria-label="Scope" value={scope} onChange={e => setScope(e.currentTarget.value as Scope)}>
                {SCOPES.map(s => (
                  <option value={s} key={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            {st.tiers.length > 0 && (
              <Field label="Priority">
                <select aria-label="Priority" value={level} onChange={e => setTier(Number(e.currentTarget.value))}>
                  {st.tiers.map((_, i) => (
                    <option value={i} key={i}>
                      Priority {i + 1}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <DateInput label="Pin start" value={pinS} set={setPinS} />
            <DateInput label="Pin end" value={pinE} set={setPinE} />
          </>
        )}
        {kind === 'ms' && <DateInput label="Pin date" value={pinE} set={setPinE} />}
        {dependsOn}
        {error && <Card tone="crit">⚠ {error}</Card>}
        <div class="tm-actions">
          <button type="submit" class="tm-primary">
            Add
          </button>
          <button type="button" onClick={() => act.ui({ form: null })}>
            {form.added.length ? 'Done' : 'Cancel'}
          </button>
        </div>
      </form>
      <div class="tm-sub tm-small tm-form-hint">Enter adds and keeps this open for the next one. New items join the forecast now, and the plan when you update it.</div>
      {form.added.length > 0 && <h3>Added</h3>}
      {form.added.map((t, i) => (
        <div class="tm-li" key={i}>
          ✓ {t}
        </div>
      ))}
    </>
  );
}
