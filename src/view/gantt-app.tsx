import { render } from 'preact';
import { analyze, type Analysis, type State, type Todo } from '../engine';
import { describeChanges } from './changes';
import { Legend, StatusBar, TopBar, TreeFoot, TreeHead } from './chrome';
import { tooltipLines } from './explain';
import { drawGantt } from './gantt/draw';
import { hitTest } from './gantt/hit';
import { buildLoad, LOAD_DAYS, type Load } from './gantt/load';
import { readPalette, type Palette } from './gantt/palette';
import { chartSpan, clampPpd, makeScale, zoomAround, type TimeScale } from './gantt/scale';
import { buildScene, projectRoots, type Bar, type Scene } from './gantt/scene';
import { Hierarchy } from './hierarchy';
import { Rail } from './rail/rail';
import { buildRows, HEAD, LOADH, ROW, rowView, type Row } from './rows';
import { defaultUi, escape, goUp, pruneUi, setFocus, toggleCollapsed, toggleHidden, type UiState } from './ui-state';

/** The slice of TaskmasterStore the view reads. */
export interface ViewStore {
  readonly state: State;
  subscribe(listener: (state: State) => void): () => void;
  readTodos(id: string): Promise<Todo[]>;
}

export interface ViewHost {
  openNote(path: string): void;
}

const WHEEL_IN = 1.15;
const WHEEL_OUT = 0.87;
const TODAY_AT = 0.22;
const TIP_W = 310;
/** Room under the last row, so it clears the load strip. */
const TAIL = 12;

const div = (parent: HTMLElement, cls: string, tag = 'div') => {
  const n = parent.ownerDocument.createElement(tag);
  n.className = cls;
  parent.append(n);
  return n;
};

/** Top bar, hierarchy, canvas, rail and status bar, kept in step. Knows nothing of Obsidian. */
export class GanttApp {
  /** Times the schedule ran. Scrolling and zooming must leave this alone. */
  recomputes = 0;

  private ui: UiState = defaultUi();
  private a: Analysis;
  private rows: Row[] = [];
  private scene!: Scene;
  private load!: Load;
  private scale!: TimeScale;
  /** Length of the chart. */
  private days = 0;
  private roots: string[] = [];
  private pal: Palette;
  private message = '';
  private centred = false;
  private raf = 0;
  private stop = new AbortController();
  private unsubscribe: () => void;
  private resize: ResizeObserver;

  private root: HTMLElement;
  private top: HTMLElement;
  private legend: HTMLElement;
  private treeHead: HTMLElement;
  private treeFoot: HTMLElement;
  private tree: HTMLElement;
  private chart: HTMLElement;
  private canvas: HTMLCanvasElement;
  private scroller: HTMLElement;
  private spacer: HTMLElement;
  private rail: HTMLElement;
  private status: HTMLElement;
  private tip: HTMLElement;
  private hierarchy: Hierarchy;

  constructor(
    host: HTMLElement,
    private store: ViewStore,
    private view: ViewHost,
  ) {
    this.root = div(host, 'tm-root');
    this.top = div(this.root, 'tm-top');
    this.legend = div(this.root, 'tm-legend');
    const main = div(this.root, 'tm-main');
    this.tree = div(main, 'tm-tree');
    this.treeHead = div(this.tree, 'tm-tree-head');
    this.hierarchy = new Hierarchy(this.tree, {
      select: id => this.select(id),
      collapse: id => this.setUi(toggleCollapsed(this.ui, id)),
      hide: id => this.setUi(toggleHidden(this.ui, id, this.st)),
      focus: id => this.focusOn(id),
      open: id => this.view.openNote(id),
    });
    this.treeFoot = div(this.tree, 'tm-tree-foot');
    this.chart = div(main, 'tm-chart');
    this.canvas = div(this.chart, 'tm-canvas', 'canvas') as HTMLCanvasElement;
    this.scroller = div(this.chart, 'tm-scroller');
    this.spacer = div(this.scroller, 'tm-spacer');
    this.rail = div(main, 'tm-rail');
    this.status = div(this.root, 'tm-status');
    this.tip = div(this.root, 'tm-tip');

    this.pal = readPalette(this.root);
    this.a = this.compute();
    this.listen();
    this.rebuild();
    this.centreToday();
    this.unsubscribe = store.subscribe(() => this.onStore());
    this.resize = new ResizeObserver(() => this.onResize());
    this.resize.observe(this.chart);
  }

  destroy() {
    this.stop.abort();
    this.unsubscribe();
    this.resize.disconnect();
    cancelAnimationFrame(this.raf);
    for (const host of [this.top, this.legend, this.treeHead, this.treeFoot, this.rail, this.status]) render(null, host);
    this.root.remove();
  }

  get ppd() {
    return this.ui.ppd;
  }

  private get st() {
    return this.store.state;
  }

  /** Esc: closes what is open, then clears selection, then goes up. */
  escape() {
    this.setUi(escape(this.ui, this.st));
  }

  refreshTheme() {
    this.pal = readPalette(this.root);
    this.paint();
  }

  /** Screen position of an item's bar, or null when it has none on the chart. */
  barRect(id: string): { x: number; y: number } | null {
    const i = this.scene.rows.findIndex(r => r.id === id);
    const bar = this.scene.rows[i]?.bars.at(-1);
    if (!bar) return null;
    const box = this.scroller.getBoundingClientRect();
    const x = (this.scale.x(bar.d0) + this.scale.x(bar.d1)) / 2 - this.scroller.scrollLeft;
    const y = HEAD + i * ROW - this.scroller.scrollTop + bar.top + bar.h / 2;
    return { x: box.left + x, y: box.top + y };
  }

  private compute(): Analysis {
    this.recomputes++;
    return analyze(this.st);
  }

  private onStore() {
    const before = this.a;
    const had = Object.keys(before.by).length > 0;
    this.a = this.compute();
    if (had) this.message = describeChanges(this.st, before, this.a);
    this.ui = pruneUi(this.ui, this.st);
    this.rebuild();
    if (!this.centred) this.centreToday();
  }

  private setUi(next: UiState) {
    const prev = this.ui;
    this.ui = next;
    if (next.focus !== prev.focus) this.scroller.scrollTop = 0;
    if (next.focus !== prev.focus || next.collapsed !== prev.collapsed || next.hidden !== prev.hidden) return this.rebuild();
    this.hierarchy.setSelected(next.sel);
    this.renderChrome();
    this.paint();
  }

  private select(id: string | null) {
    this.setUi({ ...this.ui, sel: id });
  }

  private selectAndReveal(id: string | null) {
    this.select(id);
    if (id) this.reveal(id);
  }

  private focusOn(id: string | null) {
    this.setUi(setFocus(this.ui, id));
  }

  private reveal(id: string) {
    const i = this.rows.findIndex(r => r.id === id);
    if (i < 0) return;
    const y = i * ROW;
    const view = this.scroller.clientHeight - HEAD - this.loadHeight;
    if (y < this.scroller.scrollTop) this.scroller.scrollTop = y;
    else if (y + ROW > this.scroller.scrollTop + view) this.scroller.scrollTop = y + ROW - view;
  }

  private get loadHeight() {
    return this.ui.show.load ? LOADH : 0;
  }

  /** Everything derived from data and rows. Holds the same days on screen if the chart's start moves. */
  private rebuild() {
    const { st, a, ui } = this;
    this.rows = buildRows(st, a, ui);
    this.roots = projectRoots(st, a);
    const span = chartSpan(st, a);
    const oldStart = this.scale?.a;
    this.scale = makeScale(span.a, ui.ppd);
    this.scene = buildScene(st, a, this.rows, ui);
    this.load = buildLoad(st, a, this.roots, { a: span.a, b: Math.max(span.b, span.a + LOAD_DAYS) });
    this.days = span.b - span.a;
    this.fitSpacer();
    if (oldStart != null && oldStart !== span.a) this.scroller.scrollLeft += (oldStart - span.a) * ui.ppd;

    const conflicts = new Set(a.conflicts.map(c => c.id));
    this.hierarchy.setRows(this.rows.map(r => (r.section ? null : rowView(st, a, r, conflicts, ui))));
    this.hierarchy.setSelected(ui.sel);
    this.renderChrome();
    this.paint();
  }

  private fitSpacer() {
    this.spacer.style.width = `${this.days * this.ui.ppd}px`;
    this.spacer.style.height = `${this.rows.length * ROW + HEAD + this.loadHeight + TAIL}px`;
  }

  private renderChrome() {
    const { st, a, ui, roots } = this;
    const { show } = ui;
    const flag = (cls: string, on: boolean) => this.root.classList.toggle(cls, on);
    flag('tm-no-rail', !show.rail);
    flag('tm-no-cols', !show.cols);
    flag('tm-no-status', !show.status);
    flag('tm-no-eyes', !show.eyes);
    flag('tm-no-grid', !show.grid);
    flag('tm-no-load', !show.load);
    flag('tm-no-legend', !show.legend);

    render(
      <TopBar
        st={st}
        ui={ui}
        onUp={() => this.setUi(goUp(this.ui, this.st))}
        onFocus={id => this.focusOn(id)}
        onZoom={p => this.setZoom(p, this.chart.clientWidth / 2)}
        onAxis={axis => this.setUi({ ...this.ui, axis })}
      />,
      this.top,
    );
    render(<Legend st={st} a={a} ui={ui} />, this.legend);
    render(
      <TreeHead
        st={st}
        ui={ui}
        onToggleList={() => this.setUi({ ...this.ui, hiddenOpen: !this.ui.hiddenOpen })}
        onRestore={id => this.setUi(toggleHidden(this.ui, id, this.st))}
      />,
      this.treeHead,
    );
    render(<TreeFoot st={st} roots={roots} />, this.treeFoot);
    render(
      <Rail
        st={st}
        a={a}
        ui={ui}
        roots={roots}
        readTodos={id => this.store.readTodos(id)}
        act={{
          select: id => this.selectAndReveal(id),
          focus: id => this.focusOn(id),
          openNote: path => this.view.openNote(path),
        }}
      />,
      this.rail,
    );
    render(<StatusBar st={st} a={a} message={this.message} />, this.status);
  }

  private setZoom(ppd: number, anchor: number) {
    const to = clampPpd(ppd);
    const left = zoomAround(this.scroller.scrollLeft, anchor, this.ui.ppd, to);
    this.ui = { ...this.ui, ppd: to };
    this.scale = makeScale(this.scale.a, to);
    this.fitSpacer();
    this.scroller.scrollLeft = left;
    this.renderChrome();
    this.paint();
  }

  private centreToday() {
    const width = this.chart.clientWidth;
    if (!this.st.today || !width) return;
    this.scroller.scrollLeft = this.scale.x(this.st.today) - width * TODAY_AT;
    this.centred = true;
    this.paint();
  }

  private onResize() {
    if (!this.centred) this.centreToday();
    this.paint();
  }

  private schedulePaint() {
    this.raf ||= requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  private paint() {
    const { canvas, scroller, chart } = this;
    const width = chart.clientWidth;
    const height = chart.clientHeight;
    this.hierarchy.sync(scroller.scrollTop, this.tree.clientHeight);
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const c = canvas.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGantt(c, {
      st: this.st,
      ui: this.ui,
      scene: this.scene,
      load: this.load,
      scale: this.scale,
      pal: this.pal,
      width,
      height,
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop,
    });
  }

  private hitAt(e: MouseEvent): Bar | null {
    const box = this.scroller.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    if (y < HEAD || y > this.chart.clientHeight - this.loadHeight) return null;
    return hitTest(this.scene, this.scale, x + this.scroller.scrollLeft, y - HEAD + this.scroller.scrollTop);
  }

  private hideTip() {
    this.tip.style.display = 'none';
  }

  private showTip(id: string, e: MouseEvent) {
    const { tip } = this;
    const [title, ...lines] = tooltipLines(this.st, this.a, id);
    tip.replaceChildren();
    const doc = tip.ownerDocument;
    const head = doc.createElement('b');
    head.textContent = title;
    tip.append(head);
    for (const l of lines) {
      const line = doc.createElement('div');
      line.textContent = l;
      tip.append(line);
    }
    tip.style.display = 'block';
    tip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - TIP_W)}px`;
    tip.style.top = `${e.clientY + 14}px`;
  }

  private listen() {
    const { signal } = this.stop;
    const { scroller, tree } = this;
    this.hierarchy.listen(signal);
    scroller.addEventListener('scroll', () => this.schedulePaint(), { passive: true, signal });
    tree.addEventListener(
      'wheel',
      e => {
        scroller.scrollTop += e.deltaY;
        e.preventDefault();
      },
      { passive: false, signal },
    );
    scroller.addEventListener(
      'wheel',
      e => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const anchor = e.clientX - scroller.getBoundingClientRect().left;
        this.setZoom(this.ui.ppd * (e.deltaY < 0 ? WHEEL_IN : WHEEL_OUT), anchor);
      },
      { passive: false, signal },
    );
    scroller.addEventListener(
      'pointermove',
      e => {
        const bar = this.hitAt(e);
        scroller.style.cursor = bar ? 'pointer' : '';
        if (bar) this.showTip(bar.id, e);
        else this.hideTip();
      },
      { signal },
    );
    scroller.addEventListener('pointerleave', () => this.hideTip(), { signal });
    scroller.addEventListener(
      'click',
      e => {
        const bar = this.hitAt(e);
        if (bar) this.select(bar.id);
      },
      { signal },
    );
    scroller.addEventListener(
      'dblclick',
      e => {
        const bar = this.hitAt(e);
        if (bar) this.view.openNote(bar.id);
      },
      { signal },
    );
  }
}
