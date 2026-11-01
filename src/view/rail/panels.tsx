import { leavesOf, type Scope } from '../../engine';
import { deleteLogEntry, editLogEntry, moveTask, setBudget, setDeadline, setHoursLeft, setPin, setScope, setTotal } from '../../store/edits';
import { countNotInPlan, planGapText, upcomingExternals, why } from '../explain';
import { fmtD, h1 } from '../format';
import { DateField, Deps, EdgeSwitch, LogForm, NumField } from './fields';
import { Card, Dated, Field, Link, Notes, StatusCard, Tiles, Todos, type PanelProps } from './parts';

const SCOPES: Scope[] = ['must', 'should', 'could'];

const titleOf = (st: PanelProps['st'], id: string | null | undefined) => (id ? st.items[id]?.title : null);

const Back = ({ act }: Pick<PanelProps, 'act'>) => <button onClick={() => act.select(null)}>‹ Back</button>;

/** The lists shared by a parent's overview and the top level. */
function Lists({ st, a, scope, act }: { scope: string | null } & Pick<PanelProps, 'st' | 'a' | 'act'>) {
  const leaves = scope ? new Set(leavesOf(st, scope, a.K)) : null;
  const conflicts = a.conflicts.filter(c => !leaves || c.id == null || leaves.has(c.id));
  const unplanned = countNotInPlan(st, a, scope);
  const externals = upcomingExternals(st, a, scope);
  return (
    <>
      {unplanned > 0 && (
        <Card tone="warn">
          ● {unplanned} item{unplanned > 1 ? 's are' : ' is'} not in the plan yet. The forecast includes {unplanned > 1 ? 'them' : 'it'}, the plan does not.
        </Card>
      )}
      {externals.length > 0 && <h3>External</h3>}
      {externals.map(i => (
        <div class="tm-li" key={i}>
          <Link id={i} st={st} act={act} />
          <span class="tm-num">
            {fmtD(st.items[i].pinS)} – {fmtD(st.items[i].pinE)}
          </span>
        </div>
      ))}
      {conflicts.length > 0 && <h3>Conflicts</h3>}
      {conflicts.map((c, n) => (
        <div class={c.id ? 'tm-link' : ''} key={n} onClick={() => c.id && act.select(c.id)}>
          <Card tone="crit">
            ⚠ {c.id && <b>{st.items[c.id].title}: </b>}
            {c.msg}
          </Card>
        </div>
      ))}
      <div class="tm-actions">
        <button onClick={act.openHistory}>Plan history ({st.planHistory?.length ?? 0})</button>
      </div>
    </>
  );
}

export function AllProjects({ st, a, roots, act }: Pick<PanelProps, 'st' | 'a' | 'act'> & { roots: string[] }) {
  return (
    <>
      <h2>All projects</h2>
      <div class="tm-sub">{st.settings.weekly}h/week capacity</div>
      <h3>Projects</h3>
      {roots.map((r, i) => {
        const b = a.by[r];
        return (
          <div class="tm-li" key={r}>
            <span class="tm-grow tm-link" onClick={() => act.select(r)}>
              <span class="tm-dot" style={{ background: `var(--tm-c${(i % 8) + 1})` }} />
              {st.items[r].title}
            </span>
            <span class="tm-num">
              {Math.round(b.pct * 100)}% · {fmtD(b.end)} {b.overDeadline ? <span class="tm-tone-crit">▲ {b.overDeadline}d</span> : '✓'}
            </span>
          </div>
        );
      })}
      {roots.length === 0 && <div class="tm-sub">No projects yet.</div>}
      <Lists st={st} a={a} scope={null} act={act} />
    </>
  );
}

/** A parent, selected or focused. */
export function Overview({ st, a, id, act, readTodos, previewing, selected, focused }: PanelProps & { selected: boolean; focused: boolean }) {
  const it = st.items[id];
  const b = a.by[id];
  const free = it.budget != null ? it.budget - b.spent - b.left : 0;
  const gap = planGapText(b);
  return (
    <>
      {selected && <Back act={act} />}
      <h2 class="tm-title">{it.title}</h2>
      <StatusCard st={st} a={a} id={id} />
      <Tiles st={st} a={a} id={id} />
      <div class="tm-actions">
        {!focused && <button onClick={() => act.focus(id)}>⤢ Focus chart</button>}
        <button onClick={act.openPlan}>Update plan…</button>
      </div>
      {free > 0 && <Card tone="warn">▲ {h1(free)}h of budget are not in any item yet. The forecast ignores them, so finish dates look earlier than they will be.</Card>}
      {gap && <Card tone="warn">{gap} This level's plan stays until you update it.</Card>}
      <h3>Linked notes</h3>
      <Notes st={st} id={id} act={act} />
      <h3>Properties</h3>
      <Field label="Name">{it.title}</Field>
      <Field label="Budget">
        <NumField clearable label="Budget" value={it.budget} step={1} placeholder="None" onCommit={h => act.apply(setBudget(id, h))} />
      </Field>
      <Field label="Deadline">
        <DateField label="Deadline" value={it.deadline} onCommit={d => act.apply(setDeadline(id, d))} />
      </Field>
      <Field label="Inside">{titleOf(st, it.parent) ?? 'Top level (project)'}</Field>
      <h3>Depends on</h3>
      <Deps st={st} a={a} id={id} act={act} previewing={previewing} />
      {!!it.todos?.length && (
        <>
          <h3>To-dos</h3>
          <Todos st={st} a={a} id={id} act={act} readTodos={readTodos} previewing={previewing} />
        </>
      )}
      <Lists st={st} a={a} scope={id} act={act} />
    </>
  );
}

/** A task, draft or milestone. */
export function TaskPanel({ st, a, id, act, readTodos, previewing }: PanelProps) {
  const it = st.items[id];
  const b = a.by[id];
  const ms = it.kind === 'ms';
  const level = st.tiers.findIndex(t => t.includes(id));
  const peers = level >= 0 ? st.tiers[level].filter(x => x !== id && a.by[x] && !a.by[x].done).length : 0;
  return (
    <>
      <Back act={act} />
      <h2 class="tm-title">{it.title}</h2>
      <div class="tm-sub">
        {titleOf(st, it.parent) ?? 'Top level'}
        {b.crit && <span class="tm-tone-crit"> · ◆ critical</span>}
      </div>
      <StatusCard st={st} a={a} id={id} />
      {a.conflicts
        .filter(c => c.id === id)
        .map((c, n) => (
          <Card tone="crit" key={n}>
            ⚠ {c.msg}
          </Card>
        ))}
      {!ms && <Tiles st={st} a={a} id={id} />}
      <Card>
        {why(st, a, id)}
        {b.left > 0 && !b.done && (
          <div class="tm-sub">
            Forecast {fmtD(b.start)} → {fmtD(b.end)}, avg {h1(b.burn ?? 0)}h/day
          </div>
        )}
        {peers > 0 && <div class="tm-sub">Same priority as {peers} task(s), shares burn equally</div>}
      </Card>
      <div class="tm-actions">
        <button onClick={act.openPlan}>Update plan…</button>
      </div>
      <Field label="Name">{it.title}</Field>
      <Field label="Inside">{titleOf(st, it.parent) ?? 'Top level (project)'}</Field>
      {!ms && (
        <Field label="Deadline">
          <DateField label="Deadline" value={it.deadline} onCommit={d => act.apply(setDeadline(id, d))} />
        </Field>
      )}
      <h3>Schedule</h3>
      {!ms && (
        <Field label="Start">
          <EdgeSwitch name="Start" pin={it.pinS} auto={b.start} today={st.today} onPin={d => act.apply(setPin(id, 'start', d))} />
        </Field>
      )}
      <Field label={ms ? 'Date' : 'End'}>
        <EdgeSwitch name={ms ? 'Date' : 'End'} pin={it.pinE} auto={b.end} today={st.today} onPin={d => act.apply(setPin(id, 'end', d))} />
      </Field>
      {!ms && (
        <>
          <h3>Hours</h3>
          <Field label="Total hours">
            <NumField label="Total hours" value={b.spent + b.left} onCommit={h => h != null && act.apply(setTotal(id, h))} />
          </Field>
          <Field label="Hours left">
            <NumField label="Hours left" value={b.left} onCommit={h => h != null && act.apply(setHoursLeft(id, h))} />
          </Field>
          <Field label="Log hours">
            <LogForm id={id} today={st.today} apply={act.apply} />
          </Field>
          {!!it.log?.length && <h3>Logged ({h1(b.spent)}h)</h3>}
          {it.log?.map((l, i) => (
            <div class="tm-li" key={i}>
              <Dated d={l.d} />
              <span class="tm-grow" />
              <NumField label={`Hours logged ${fmtD(l.d)}`} value={l.h} step={0.25} onCommit={h => h != null && act.apply(editLogEntry(id, i, h))} />
              <button class="tm-x-btn" title="Delete entry, hours return to left" aria-label={`Delete log entry ${fmtD(l.d)}`} onClick={() => act.apply(deleteLogEntry(id, i))}>
                ×
              </button>
            </div>
          ))}
          <h3>Priority and scope</h3>
          <Field label="Priority">
            {level < 0 ? (
              'None'
            ) : (
              <select aria-label="Priority" value={level} onChange={e => act.apply(moveTask(id, Number(e.currentTarget.value)))}>
                {st.tiers.map((_, i) => (
                  <option value={i} key={i}>
                    Priority {i + 1}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Scope">
            <select aria-label="Scope" value={it.scope ?? 'must'} onChange={e => act.apply(setScope(id, e.currentTarget.value as Scope))}>
              {SCOPES.map(s => (
                <option value={s} key={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      <h3>Depends on</h3>
      <Deps st={st} a={a} id={id} act={act} previewing={previewing} />
      {!ms && (
        <>
          <h3>To-dos</h3>
          <Todos st={st} a={a} id={id} act={act} readTodos={readTodos} previewing={previewing} />
        </>
      )}
      <h3>Linked notes</h3>
      <Notes st={st} id={id} act={act} />
    </>
  );
}

/** Read-only for now: editing and the effect figures come later. */
export function ExternalPanel({ st, a, id, act }: Omit<PanelProps, 'readTodos' | 'previewing'>) {
  const it = st.items[id];
  const b = a.by[id];
  const blocks = Object.keys(st.items)
    .filter(i => st.items[i].deps?.includes(id))
    .sort((x, y) => st.items[x].title.localeCompare(st.items[y].title));
  return (
    <>
      <Back act={act} />
      <h2 class="tm-title">{it.title}</h2>
      <div class="tm-sub">
        External{b.done && ', finished'}
        {b.crit && !b.done && <span class="tm-tone-crit"> · ◆ on the critical chain</span>}
      </div>
      <Card>No project hours and no capacity. Anything linked below starts the day after it ends.</Card>
      <h3>Dates</h3>
      <Field label="Name">{it.title}</Field>
      <Field label="Start">{fmtD(it.pinS)}</Field>
      <Field label="End">{fmtD(it.pinE)}</Field>
      <h3>Blocks</h3>
      {blocks.map(d => (
        <div class="tm-li" key={d}>
          <Link id={d} st={st} act={act} />
          <Dated d={a.by[d]?.start} />
        </div>
      ))}
      {!blocks.length && <div class="tm-sub">Nothing</div>}
      <h3>Linked notes</h3>
      <Notes st={st} id={id} act={act} />
    </>
  );
}
