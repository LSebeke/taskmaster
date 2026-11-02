import type { Analysis, State } from '../engine';

const SHOWN = 4;

/** Status bar line: what happened, how many tasks moved, and the largest moves. */
export function describeChanges(st: State, before: Analysis, after: Analysis, label?: string): string {
  const moved: { id: string; days: number }[] = [];
  for (const id in after.results) {
    if (after.kids[id]) continue;
    const was = before.results[id]?.end;
    const now = after.results[id].end;
    if (was != null && now != null && was !== now) moved.push({ id, days: now - was });
  }
  if (!moved.length) return `${label ?? 'Notes changed'}: no forecast change`;
  moved.sort((x, y) => Math.abs(y.days) - Math.abs(x.days));
  const top = moved.slice(0, SHOWN).map(m => `${st.items[m.id].title} ${m.days > 0 ? '+' : ''}${m.days}d`);
  const line = `orecast moved on ${moved.length} task${moved.length > 1 ? 's' : ''}: ${top.join(', ')}${moved.length > SHOWN ? '…' : ''}`;
  return label ? `${label}: f${line}` : `F${line}`;
}
