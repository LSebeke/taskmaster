import { moveError, type KidsMap, type State } from '../engine';
import { moveEdit, type Edit } from '../store/edits';
import { h1 } from './format';

/** Press and move this far before a row counts as dragged, so clicks stay clicks. */
const START_PX = 4;
const EDGE = 0.25;

export type Zone = 'before' | 'after' | 'in';

export interface RowHit {
  id: string;
  index: number;
  depth: number;
  /** How far down the row the pointer is, 0 to 1. */
  share: number;
}

/** Where a drop would land, drawn over the rows. */
export interface DropMark {
  index: number;
  depth: number;
  zone: Zone;
  refused: boolean;
}

export interface Drop {
  zone: Zone;
  parent: string | null;
  before: string | null;
  error: string | null;
}

/** Top quarter before, bottom quarter after, middle inside: all with the rules of a move. */
export function dropOn(st: State, K: KidsMap, id: string, target: string, share: number): Drop {
  const zone: Zone = share < EDGE ? 'before' : share > 1 - EDGE ? 'after' : 'in';
  const T = st.items[target];
  const parent = zone === 'in' ? target : (T.parent ?? null);
  const siblings = (K[T.parent ?? ''] ?? []).filter(x => x !== id && st.items[x].kind !== 'ext');
  const before = zone === 'before' ? target : zone === 'after' ? (siblings[siblings.indexOf(target) + 1] ?? null) : null;
  const beside = T.kind === 'ext' && zone !== 'in' && st.items[id].kind !== 'ext';
  return { zone, parent, before, error: beside ? 'External items stay in their own section.' : moveError(st, id, parent) };
}

/** What a drop does to the items around it, in words. The forecast's part is added by the caller. */
function dropText(st: State, K: KidsMap, id: string, target: string, d: Drop): string {
  const T = st.items[target];
  const hours = (T.spent ?? 0) + (T.left ?? 0);
  const place = d.zone === 'in' ? `Move into ${T.title}${!K[target] && hours > 0 && T.budget == null ? `: its ${h1(hours)}h become its budget` : ''}` : `Place ${d.zone} ${T.title}${d.parent ? '' : ' as a project'}`;
  const from = st.items[id].parent;
  const P = from && from !== d.parent ? st.items[from] : null;
  return P && K[from!]?.length === 1 && P.budget != null ? `${place}. ${P.title}'s ${h1(P.budget)}h budget becomes hours again` : place;
}

export interface RowDragHost {
  readonly tree: HTMLElement;
  readonly state: State;
  readonly kids: KidsMap;
  rowAt(clientY: number): RowHit | null;
  /** Status bar line for what an edit would do. */
  consequence(label: string, edit: Edit): string;
  /** Says something, and returns what was said before. */
  say(text: string): string;
  mark(mark: DropMark | null): void;
  dragging(id: string | null): void;
  move(id: string, drop: Drop): void;
}

interface Press {
  id: string;
  title: string;
  x: number;
  y: number;
  pointer: number;
  live: boolean;
  drop: Drop | null;
  /** Row and zone the status bar speaks of. Working out a consequence runs the schedule. */
  shown: string;
  /** Status bar before the drag. */
  was: string;
}

/** Moving items by dragging rows. Everything it shows floats over the column, so nothing shifts. */
export class RowDrag {
  private now: Press | null = null;
  private ghost: HTMLElement | null = null;

  constructor(private host: RowDragHost) {}

  get active() {
    return !!this.now?.live;
  }

  down(e: PointerEvent, id: string) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    this.now = { id, title: this.host.state.items[id].title, x: e.clientX, y: e.clientY, pointer: e.pointerId, live: false, drop: null, shown: '', was: '' };
  }

  move(e: PointerEvent) {
    const p = this.now;
    if (!p) return;
    if (!p.live) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < START_PX) return;
      this.start(p);
    }
    this.ghost!.style.transform = `translate(${e.clientX + 12}px,${e.clientY + 10}px)`;
    this.aim(p, this.host.rowAt(e.clientY));
  }

  up() {
    const p = this.now;
    if (!p) return;
    const { drop } = p;
    this.finish(p);
    if (!p.live) return;
    if (drop && !drop.error) this.host.move(p.id, drop);
    else this.host.say(p.was);
  }

  /** Returns whether there was a drag to drop. */
  cancel(): boolean {
    const p = this.now;
    if (!p) return false;
    this.finish(p);
    if (p.live) this.host.say(p.was);
    return p.live;
  }

  private start(p: Press) {
    const { tree } = this.host;
    p.live = true;
    p.was = this.host.say(`Moving ${p.title}`);
    tree.setPointerCapture(p.pointer);
    tree.classList.add('tm-row-dragging');
    this.host.dragging(p.id);
    const ghost = tree.ownerDocument.createElement('div');
    ghost.className = 'tm-drag-ghost';
    ghost.textContent = p.title;
    // Inside the root, where the theme's variables are.
    tree.parentElement!.closest('.tm-root')!.append(ghost);
    this.ghost = ghost;
  }

  private aim(p: Press, hit: RowHit | null) {
    if (!hit || hit.id === p.id) {
      p.drop = null;
      p.shown = '';
      this.host.mark(null);
      return;
    }
    const { state: st, kids } = this.host;
    const drop = dropOn(st, kids, p.id, hit.id, hit.share);
    const key = `${hit.id}|${drop.zone}`;
    if (key === p.shown) return;
    p.shown = key;
    p.drop = drop;
    this.host.mark({ index: hit.index, depth: hit.depth, zone: drop.zone, refused: !!drop.error });
    this.host.say(drop.error ? `⚠ ${drop.error}` : this.host.consequence(dropText(st, kids, p.id, hit.id, drop), moveEdit(p.id, drop.parent, drop.before)));
  }

  private finish(p: Press) {
    const { tree } = this.host;
    this.now = null;
    if (!p.live) return;
    if (tree.hasPointerCapture(p.pointer)) tree.releasePointerCapture(p.pointer);
    tree.classList.remove('tm-row-dragging');
    this.ghost?.remove();
    this.ghost = null;
    this.host.mark(null);
    this.host.dragging(null);
  }
}
