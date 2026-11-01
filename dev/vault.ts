import { iso, kids, type Day, type Item, type State } from '../src/engine';
import { serializeState } from '../src/store/state-file';
import { FakeObsidian } from '../tests/store/fake-obsidian';

const date = (d: Day | null | undefined) => (d == null ? undefined : iso(d));
const TYPES = { item: 'item', ms: 'milestone', ext: 'external' };

/** Drops the keys a real note would not have. */
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Turns seed data into the notes and state.json a real vault would hold, so the real store reads them. */
export function vaultFrom(st: State): { vault: FakeObsidian; pathOf: (id: string) => string } {
  const vault = new FakeObsidian();
  const K = kids(st);
  const folderOf = (id: string): string => {
    const it = st.items[id];
    if (it.kind === 'ext') return 'Projects/_external';
    return it.parent ? `${folderOf(it.parent)}/${st.items[it.parent].title}` : 'Projects';
  };
  const paths: Record<string, string> = {};
  for (const id in st.items) {
    const { title } = st.items[id];
    paths[id] = K[id] ? `${folderOf(id)}/${title}/${title}.md` : `${folderOf(id)}/${title}.md`;
  }
  const link = (id: string) => `[[${paths[id].replace(/\.md$/, '')}]]`;

  const frontmatter = (it: Item) =>
    compact({
      'tm-type': TYPES[it.kind],
      'tm-parent': it.parent ? link(it.parent) : undefined,
      'tm-deps': it.deps?.length ? it.deps.map(link) : undefined,
      'tm-estimate': it.est,
      'tm-left': it.kind === 'item' ? it.left : undefined,
      'tm-left-updated': date(it.touched ?? it.doneOn),
      'tm-log': it.log?.map(e => `${iso(e.d)} ${e.h}`),
      'tm-started': date(it.actualStart),
      'tm-pin-start': date(it.pinS),
      'tm-pin-end': date(it.pinE),
      'tm-scope': it.scope && it.scope !== 'must' ? it.scope : undefined,
      'tm-deadline': date(it.deadline),
      'tm-budget': it.budget,
      'tm-notes': it.notes?.length ? it.notes.map(n => `[[${n}]]`) : undefined,
    });

  for (const [id, it] of Object.entries(st.items)) {
    let body = '';
    const listItems = (it.todos ?? []).map(t => {
      const line = `- [${t.done ? 'x' : ' '}] ${t.t}\n`;
      const start = body.length;
      body += line;
      return { task: t.done ? 'x' : ' ', position: { start: { offset: start }, end: { offset: start + line.length - 1 } } };
    });
    vault.add(paths[id], frontmatter(it), listItems, body);
    for (const n of it.notes ?? []) vault.add(`Notes/${n}.md`);
  }

  const keyed = <T,>(o: Partial<Record<string, T>>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [paths[k], v]));
  vault.stateJson = serializeState({ ...st, tiers: st.tiers.map(t => t.map(id => paths[id])), plan: keyed(st.plan) });
  return { vault, pathOf: id => paths[id] };
}
