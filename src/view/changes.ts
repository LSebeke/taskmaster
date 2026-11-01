import type { Analysis, State } from '../engine';

const SHOWN = 4;

/** Status bar line: how many tasks moved, and the largest moves. */
export function describeChanges(st: State, before: Analysis, after: Analysis): string {
  const moved: { id: string; days: number }[] = [];
  for (const id in after.by) {
    if (after.K[id]) continue;
    const was = before.by[id]?.end;
    const now = after.by[id].end;
    if (was != null && now != null && was !== now) moved.push({ id, days: now - was });
  }
  if (!moved.length) return 'Notes changed: no forecast change';
  moved.sort((x, y) => Math.abs(y.days) - Math.abs(x.days));
  const top = moved.slice(0, SHOWN).map(m => `${st.items[m.id].title} ${m.days > 0 ? '+' : ''}${m.days}d`);
  return `Forecast moved on ${moved.length} task${moved.length > 1 ? 's' : ''}: ${top.join(', ')}${moved.length > SHOWN ? '…' : ''}`;
}
