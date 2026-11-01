import { useMemo, useRef, useState } from 'preact/hooks';
import { placeError, subtree } from '../../engine';
import { addDep, removeDep } from '../../store/edits';
import { blockChoices, parentChoices } from '../deps';
import { Dated, Link, type PanelProps } from './parts';

const INDENT = '   ';

/** Commits on Enter or leaving. A blank name goes back. */
export function NameField({ value, onCommit }: { value: string; onCommit(title: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const commit = () => {
    setDraft(null);
    const typed = ref.current!.value.trim();
    if (typed && typed !== value) onCommit(typed);
  };
  return (
    <input
      ref={ref}
      class="tm-name-in"
      aria-label="Name"
      value={draft ?? value}
      onInput={e => setDraft(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

/** The tree. What a move cannot do from the shape of it is disabled; a dependency loop is refused on choosing. */
export function InsidePicker({ st, a, id, act, previewing }: Pick<PanelProps, 'st' | 'a' | 'id' | 'act' | 'previewing'>) {
  const here = st.items[id].parent ?? '';
  const options = useMemo(() => parentChoices(st, a.K, true), [previewing ? null : st]);
  return (
    <select
      aria-label="Inside"
      value={here}
      onChange={e => {
        const to = e.currentTarget.value;
        e.currentTarget.value = here;
        act.move(id, to || null);
      }}
    >
      <option value="" disabled={!!placeError(st, id, null)}>
        Top level (project)
      </option>
      {options.map(o => (
        <option value={o.id} key={o.id} disabled={!!placeError(st, id, o.id)}>
          {INDENT.repeat(o.depth)}
          {o.title}
        </option>
      ))}
    </select>
  );
}

/** Asks for a second click, with the count. Moving away takes the question back. */
export function DeleteButton({ st, a, id, act }: Pick<PanelProps, 'st' | 'a' | 'id' | 'act'>) {
  const [armed, setArmed] = useState(false);
  const count = armed ? subtree(id, a.K).length : 0;
  return (
    <div class="tm-actions">
      <button class={`tm-del${armed ? ' tm-armed' : ''}`} title={`Delete ${st.items[id].title}. Its notes go to the trash`} onMouseLeave={() => setArmed(false)} onBlur={() => setArmed(false)} onClick={() => (armed ? act.remove(id) : setArmed(true))}>
        {armed ? `Click again to delete ${count} item${count > 1 ? 's' : ''}` : 'Delete'}
      </button>
    </div>
  );
}

/** What waits for an external item: each one's dependency, seen from here. */
export function Blocks({ st, a, id, act, previewing }: Pick<PanelProps, 'st' | 'a' | 'id' | 'act' | 'previewing'>) {
  const blocked = Object.keys(st.items)
    .filter(i => st.items[i].deps?.includes(id))
    .sort((x, y) => st.items[x].title.localeCompare(st.items[y].title));
  const groups = useMemo(() => blockChoices(st, id), [id, previewing ? null : st]);
  return (
    <>
      {blocked.map(d => (
        <div class="tm-li" key={d}>
          <Link id={d} st={st} act={act} />
          <Dated d={a.by[d]?.start} />
          <button class="tm-x-btn" title="Stop blocking this" aria-label={`Stop blocking ${st.items[d].title}`} onClick={() => act.apply(removeDep(d, id))}>
            ×
          </button>
        </div>
      ))}
      {!blocked.length && <div class="tm-sub">Nothing</div>}
      <select
        class="tm-dep-pick"
        aria-label="Add blocked item"
        value=""
        onChange={e => {
          const item = e.currentTarget.value;
          e.currentTarget.value = '';
          if (item) act.apply(addDep(item, id));
        }}
      >
        <option value="">+ Add blocked item…</option>
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
