import { mvpVerdict, type Day, type MvpVerdict } from '../../engine';
import { fmtD, h1 } from '../format';
import { Card, Link, type PanelProps } from './parts';

const VERDICTS: Record<MvpVerdict, { tone: string; head: string }> = {
  full: { tone: 'good', head: '✓ Full scope makes it' },
  'no-could': { tone: 'warn', head: '▲ Drop could-haves' },
  'must-only': { tone: 'warn', head: '▲ MVP mode: must-haves only' },
  miss: { tone: 'crit', head: '▲ Even must-haves miss: change the plan' },
};

const finish = (d: Day | null) => (d == null ? 'nothing left' : d === Infinity ? 'never' : fmtD(d));

function Option({ label, day, saves, deadline }: { label: string; day: Day | null; saves?: number; deadline: Day }) {
  return (
    <div class="tm-li">
      <span class="tm-grow">
        {label}
        {!!saves && <span class="tm-sub"> (−{h1(saves)}h)</span>}
      </span>
      <span class="tm-num">
        {finish(day)} {day == null || day <= deadline ? '✓' : '▲'}
      </span>
    </div>
  );
}

/** Reruns the schedule, so it mounts only for a project on screen. */
export function MvpCard({ st, a, id, act, previewing }: Pick<PanelProps, 'st' | 'a' | 'id' | 'act' | 'previewing'>) {
  const m = act.signals.mvp(st, a, id, previewing);
  const verdict = mvpVerdict(m);
  if (!verdict) return null;
  const { tone, head } = VERDICTS[verdict];
  return (
    <>
      <h3>Will I make it?</h3>
      <div class="tm-mvp">
        <Card tone={tone}>
          <b>{head}</b>
          <Option label="Full scope" day={m.full} deadline={m.deadline!} />
          <Option label="No could-haves" day={m.noCould} saves={m.noCouldH} deadline={m.deadline!} />
          <Option label="Must-haves only" day={m.mustOnly} saves={m.mustOnlyH} deadline={m.deadline!} />
          <div class="tm-sub">Deadline {fmtD(m.deadline)}</div>
        </Card>
      </div>
    </>
  );
}

export function EstimateCard({ st, a, id, act, previewing }: Pick<PanelProps, 'st' | 'a' | 'id' | 'act' | 'previewing'>) {
  const e = act.signals.estimate(st, a, id, previewing);
  if (!e) return null;
  return (
    <>
      <h3>Your estimates</h3>
      <div class="tm-estimate">
        <Card>
          Finished tasks ran <b>{h1(e.ratio)}×</b> estimate. Adjusted finish: <b>{finish(e.finish)}</b>
        </Card>
      </div>
    </>
  );
}

export function ExternalEffect({ st, a, id, act, previewing }: Pick<PanelProps, 'st' | 'a' | 'id' | 'act' | 'previewing'>) {
  const fx = act.signals.external(st, a, id, previewing);
  return (
    <div class="tm-effect">
      {fx.items.map(x => (
        <div class="tm-li" key={x.id}>
          <Link id={x.id} st={st} act={act} />
          <span class="tm-num">{x.days ? `▲ starts ${x.days}d later` : 'no delay'}</span>
        </div>
      ))}
      {fx.projects.map(p => (
        <div class="tm-li" key={p.root}>
          <span class="tm-grow tm-sub">{st.items[p.root].title} finish</span>
          <span class="tm-num">{p.days ? `▲ ${p.days}d later` : 'unchanged'}</span>
        </div>
      ))}
      {!fx.items.length && <div class="tm-sub">Nothing depends on it yet</div>}
    </div>
  );
}

/** Start, stop, or stop the other task and start here. */
export function TimerControl({ st, id, act }: Pick<PanelProps, 'st' | 'id' | 'act'>) {
  const { timer } = act;
  if (timer?.id === id) {
    return (
      <div class="tm-actions">
        <button onClick={act.stopTimer}>Stop timer</button>
      </div>
    );
  }
  if (!(st.items[id].left! > 0)) return <div class="tm-sub">Needs hours left to time it.</div>;
  return (
    <div class="tm-actions">
      <button onClick={() => act.startTimer(id)}>{timer ? `Stop ${st.items[timer.id].title}, start here` : 'Start timer'}</button>
    </div>
  );
}
