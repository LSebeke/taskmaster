import type { DropMark } from './row-drag';
import { HEAD, ROW, rowWindow, type RowView } from './rows';

export const EYE =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
export const EYE_OFF =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18M10 6a9 9 0 0 1 12 6 14 14 0 0 1-3 4M6 7a14 14 0 0 0-4 5s4 7 10 7c2 0 3-.4 5-1"/></svg>';

export interface HierarchyActions {
  select(id: string): void;
  collapse(id: string): void;
  hide(id: string): void;
  focus(id: string): void;
  open(id: string): void;
  add(id: string): void;
}

const INDENT = 14;
/** Width of the eye column. */
const EYE_W = 32;

/** Windowed rows. Mounted nodes stay put between renders, so hover and double-click survive a selection. */
export class Hierarchy {
  readonly el: HTMLElement;
  private views: (RowView | null)[] = [];
  private mounted = new Map<number, HTMLElement>();
  private selected: string | null = null;
  private dragged: string | null = null;
  private dropEl: HTMLElement | null = null;

  constructor(host: HTMLElement, private on: HierarchyActions) {
    this.el = host.ownerDocument.createElement('div');
    this.el.className = 'tm-rows';
    host.append(this.el);
  }

  listen(signal: AbortSignal) {
    this.el.addEventListener('click', e => this.click(e), { signal });
    this.el.addEventListener(
      'dblclick',
      e => {
        const t = e.target as HTMLElement;
        const id = t.closest<HTMLElement>('[data-row]')?.dataset.row;
        if (id && !t.closest('button')) this.on.open(id);
      },
      { signal },
    );
  }

  private click(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const hit = (attr: string) => t.closest<HTMLElement>(`[data-${attr}]`)?.dataset[attr];
    const eye = hit('eye');
    if (eye) return this.on.hide(eye);
    const car = hit('car');
    if (car) return this.on.collapse(car);
    const focus = hit('focus');
    if (focus) return this.on.focus(focus);
    const add = hit('add');
    if (add) return this.on.add(add);
    const row = hit('row');
    if (row) this.on.select(row);
  }

  /** New content. Null is the External section header. */
  setRows(views: (RowView | null)[]) {
    this.views = views;
    for (const node of this.mounted.values()) node.remove();
    this.mounted.clear();
  }

  setSelected(id: string | null) {
    this.selected = id;
    for (const node of this.mounted.values()) node.classList.toggle('tm-selected', node.dataset.row === id);
  }

  /** Dims the row being dragged, also if it scrolls out and back. */
  setDragged(id: string | null) {
    this.dragged = id;
    for (const node of this.mounted.values()) node.classList.toggle('tm-dragsrc', node.dataset.row === id);
  }

  /** The outline or insertion line of a row drag. It rides on the rows, so it scrolls with them. */
  setDrop(mark: DropMark | null) {
    if (!mark) {
      this.dropEl?.remove();
      this.dropEl = null;
      return;
    }
    this.dropEl ??= this.el.appendChild(this.el.ownerDocument.createElement('div'));
    const { index, depth, zone, refused } = mark;
    const line = zone !== 'in' && !refused;
    const y = HEAD + (zone === 'after' ? index + 1 : index) * ROW;
    this.dropEl.className = `tm-drop ${refused ? 'tm-drop-no' : line ? 'tm-drop-line' : 'tm-drop-in'}`;
    this.dropEl.style.top = `${line ? y - 1 : HEAD + index * ROW}px`;
    this.dropEl.style.left = line ? `${EYE_W + depth * INDENT}px` : '0';
  }

  /** Mounts what is in view, drops what left, and moves the lot with one transform. */
  sync(scrollTop: number, height: number) {
    const [i0, i1] = rowWindow(scrollTop, height, this.views.length);
    for (const [i, node] of this.mounted) {
      if (i >= i0 && i < i1) continue;
      node.remove();
      this.mounted.delete(i);
    }
    for (let i = i0; i < i1; i++) {
      if (this.mounted.has(i)) continue;
      const node = this.renderRow(this.views[i], i);
      this.mounted.set(i, node);
      this.el.append(node);
    }
    this.el.style.transform = `translateY(${-scrollTop}px)`;
  }

  private renderRow(v: RowView | null, i: number): HTMLElement {
    const doc = this.el.ownerDocument;
    const make = (tag: string, cls: string, text?: string) => {
      const n = doc.createElement(tag);
      n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const row = make('div', 'tm-row');
    row.style.top = `${HEAD + i * ROW}px`;
    if (!v) {
      row.classList.add('tm-sec');
      row.append(make('span', 'tm-t', 'External'));
      return row;
    }

    row.dataset.row = v.id;
    row.classList.toggle('tm-group', v.group);
    row.classList.toggle('tm-done', v.isDone);
    row.classList.toggle('tm-selected', v.id === this.selected);
    row.classList.toggle('tm-dragsrc', v.id === this.dragged);

    const eye = make('button', 'tm-eye');
    eye.dataset.eye = v.id;
    eye.title = 'Hide from chart';
    eye.setAttribute('aria-label', `Hide ${v.title}`);
    eye.innerHTML = EYE;

    const indent = make('span', 'tm-ind');
    indent.style.width = `${v.depth * INDENT}px`;

    let toggle: HTMLElement;
    if (v.group) {
      toggle = make('button', 'tm-col', v.collapsed ? '▸' : '▾');
      toggle.dataset.car = v.id;
      toggle.title = v.collapsed ? 'Expand' : 'Collapse';
    } else toggle = make('span', 'tm-nocol', v.glyph ?? '');

    const title = make('span', 'tm-t');
    title.title = v.title;
    if (v.conflict) {
      const warn = make('span', 'tm-conflict', '⚠ ');
      warn.title = 'Conflict';
      title.append(warn);
    }
    title.append(v.title);

    row.append(eye, indent, toggle, title);
    if (v.canAdd) {
      const add = make('button', 'tm-add', '+ Add');
      add.dataset.add = v.id;
      add.title = 'Add an item inside this';
      row.append(add);
    }
    if (v.group) {
      const focus = make('button', 'tm-fb', '⤢ Focus');
      focus.dataset.focus = v.id;
      focus.title = 'Zoom the chart to this';
      row.append(focus);
    }
    const marker = make('span', `tm-s tm-tone-${v.marker.tone}`, v.marker.text);
    if (v.marker.title) marker.title = v.marker.title;
    row.append(make('span', 'tm-n', v.done), marker);
    return row;
  }
}
