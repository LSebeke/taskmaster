import { leavesOf } from '../../engine';
import { countNotInPlan, upcomingExternals, why } from '../explain';
import { fmtD, h1 } from '../format';
import { Card, Dated, Field, Link, Notes, StatusCard, Tiles, Todos, type PanelProps } from './parts';

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
      {unplanned > 0 && <Card tone="warn">● {unplanned} item(s) are not in the plan yet. The forecast includes them, the plan does not.</Card>}
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
export function Overview({ st, a, id, act, readTodos, selected, focused }: PanelProps & { selected: boolean; focused: boolean }) {
  const it = st.items[id];
  const b = a.by[id];
  const free = it.budget != null ? it.budget - b.spent - b.left : 0;
  return (
    <>
      {selected && <Back act={act} />}
      <h2 class="tm-title">{it.title}</h2>
      <StatusCard st={st} a={a} id={id} />
      <Tiles st={st} a={a} id={id} />
      {!focused && (
        <div class="tm-actions">
          <button onClick={() => act.focus(id)}>⤢ Focus chart</button>
        </div>
      )}
      {free > 0 && <Card tone="warn">▲ {h1(free)}h of budget are not in any item yet. The forecast ignores them, so finish dates look earlier than they will be.</Card>}
      {(b.planGap || b.planGapH) && (
        <Card tone="warn">
          ▲ Sub-level plans outgrew this plan by {b.planGap ? `${b.planGap} working days` : ''} {b.planGapH ? `${h1(b.planGapH)}h` : ''}. This level stays until you update it from one level up.
        </Card>
      )}
      <h3>Linked notes</h3>
      <Notes st={st} id={id} act={act} />
      <h3>Properties</h3>
      <Field label="Name">{it.title}</Field>
      <Field label="Budget">{it.budget != null ? `${h1(it.budget)}h` : 'None'}</Field>
      <Field label="Deadline">{it.deadline != null ? fmtD(it.deadline) : 'None'}</Field>
      <Field label="Inside">{titleOf(st, it.parent) ?? 'Top level (project)'}</Field>
      {!!it.todos?.length && (
        <>
          <h3>To-dos</h3>
          <Todos a={a} id={id} readTodos={readTodos} />
        </>
      )}
      <Lists st={st} a={a} scope={id} act={act} />
    </>
  );
}

/** A task, draft or milestone. */
export function TaskPanel({ st, a, id, act, readTodos }: PanelProps) {
  const it = st.items[id];
  const b = a.by[id];
  const ms = it.kind === 'ms';
  const level = st.tiers.findIndex(t => t.includes(id));
  const peers = level >= 0 ? st.tiers[level].filter(x => x !== id && a.by[x] && !a.by[x].done).length : 0;
  const edge = (pin: number | null | undefined, auto: number | null) => (pin != null ? `Pinned, ${fmtD(pin)}` : `Auto, ${fmtD(auto)}`);
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
      <Field label="Name">{it.title}</Field>
      <Field label="Inside">{titleOf(st, it.parent) ?? 'Top level (project)'}</Field>
      {!ms && <Field label="Deadline">{it.deadline != null ? fmtD(it.deadline) : 'None'}</Field>}
      <h3>Schedule</h3>
      <Field label="Start">{edge(ms ? undefined : it.pinS, b.start)}</Field>
      <Field label="End">{edge(it.pinE, b.end)}</Field>
      {!ms && (
        <>
          <h3>Hours</h3>
          <Field label="Total hours">{h1(b.spent + b.left)}h</Field>
          <Field label="Hours left">{h1(b.left)}h</Field>
          {!!it.log?.length && <h3>Logged ({h1(b.spent)}h)</h3>}
          {it.log?.map(l => (
            <div class="tm-li" key={l.d}>
              <Dated d={l.d} />
              <span class="tm-grow" />
              <span class="tm-num">{h1(l.h)}h</span>
            </div>
          ))}
          <h3>Priority and scope</h3>
          <Field label="Priority">{level >= 0 ? `Priority ${level + 1}` : 'None'}</Field>
          <Field label="Scope">{it.scope ?? 'must'}</Field>
        </>
      )}
      <h3>Depends on</h3>
      {(it.deps ?? []).map(d => (
        <div class="tm-li" key={d}>
          <Link id={d} st={st} act={act} />
          <Dated d={a.by[d]?.end} />
        </div>
      ))}
      {!it.deps?.length && <div class="tm-sub">Nothing</div>}
      {!ms && (
        <>
          <h3>To-dos</h3>
          <Todos a={a} id={id} readTodos={readTodos} />
        </>
      )}
      <h3>Linked notes</h3>
      <Notes st={st} id={id} act={act} />
    </>
  );
}

/** Read-only for now: editing and the effect figures come later. */
export function ExternalPanel({ st, a, id, act }: Omit<PanelProps, 'readTodos'>) {
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
