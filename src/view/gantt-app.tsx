import { render } from 'preact';
import { analyze, isoWeekKey, type Analysis, type State, type Todo } from '../engine';
import { setWeekCapacity, setWeekly, updatePlan, type Edit } from '../store/edits';
import { describeChanges } from './changes';
import { Legend, StatusBar, TopBar, TreeFoot, TreeHead, WeekEdit } from './chrome';
import { tooltipLines } from './explain';
import { h1 } from './format';
import { drawGantt } from './gantt/draw';
import { dotAt, forecastBar } from './gantt/drag';
import { Gestures, type GestureHost, type Hot, type Spot } from './gantt/gestures';
import { hitTest } from './gantt/hit';
import { buildLoad, LOAD_DAYS, loadWeekAt, type Load, type LoadWeek } from './gantt/load';
import { readPalette, type Palette } from './gantt/palette';
import { chartSpan, clampPpd, makeScale, zoomAround, type TimeScale } from './gantt/scale';
import { buildScene, projectRoots, type Bar, type Scene } from './gantt/scene';
import { Hierarchy } from './hierarchy';
import { HistoryDialog, PlanDialogBox } from './plan-dialog';
import { openPlan, planTarget, setPlanDeep, togglePlanRow } from './plan-ui';
import { Rail } from './rail/rail';
import { buildRows, HEAD, LOADH, ROW, rowView, type Row } from './rows';
import { cleanForSharing, defaultUi, defaultView, escape, goUp, pruneUi, setFocus, setLayer, setShow, toggleCollapsed, toggleHidden, type UiState } from './ui-state';

/** The slice of TaskmasterStore the view reads. */
export interface ViewStore {
  readonly state: State;
  readonly undoLabel: string | null;
  subscribe(listener: (state: State, label?: string) => void): () => void;
  readTodos(id: string): Promise<Todo[]>;
  apply(edit: Edit): boolean;
  undo(): Promise<string | null>;
}

export interface ViewHost {
  openNote(path: string): void;
}

const WHEEL_IN = 1.15;
const WHEEL_OUT = 0.87;
const TODAY_AT = 0.22;
const TIP_W = 310;
const WEEK_EDIT_W = 130;
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
  /** A schedule a drag is showing. The store only hears of it on drop. */
  private shown: State | null = null;
  /** The analysis of the stored state while `shown` is up. */
  private stored: Analysis | null = null;
  private hot: Hot = { row: null, link: null };
  private gestures: Gestures;
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
  private overlay: HTMLElement;
  private dialog: HTMLElement;
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
    this.overlay = div(this.chart, 'tm-overlay');
    this.rail = div(main, 'tm-rail');
    this.status = div(this.root, 'tm-status');
    this.tip = div(this.root, 'tm-tip');
    this.dialog = div(this.root, 'tm-dialog-host');

    this.pal = readPalette(this.root);
    this.a = this.compute();
    this.gestures = new Gestures(this.gestureHost());
    this.listen();
    this.rebuild();
    this.centreToday();
    this.unsubscribe = store.subscribe((_, label) => this.onStore(label));
    this.resize = new ResizeObserver(() => this.onResize());
    this.resize.observe(this.chart);
  }

  destroy() {
    this.stop.abort();
    this.unsubscribe();
    this.resize.disconnect();
    cancelAnimationFrame(this.raf);
    for (const host of [this.top, this.legend, this.treeHead, this.treeFoot, this.rail, this.status, this.overlay, this.dialog]) render(null, host);
    this.root.remove();
  }

  get ppd() {
    return this.ui.ppd;
  }

  private get st() {
    return this.shown ?? this.store.state;
  }

  /** Esc: drops a gesture, closes what is open, then clears selection, then goes up. */
  escape() {
    if (this.gestures.cancel()) return;
    this.setUi(escape(this.ui, this.st));
  }

  undo() {
    if (!this.gestures.active) void this.store.undo();
  }

  refreshTheme() {
    this.pal = readPalette(this.root);
    this.paint();
  }

  /** Links on the chart, for checks that a canvas cannot answer. */
  get links() {
    return this.scene.links;
  }

  /** Screen geometry of an item's bar, or null when it has none on the chart. The forecast bar with `fc`. */
  barRect(id: string, fc = false): { x: number; y: number; x0: number; x1: number; dot: { x: number; y: number } } | null {
    const i = this.scene.rows.findIndex(r => r.id === id);
    const row = this.scene.rows[i];
    const bar = fc ? forecastBar(row) : row?.bars.at(-1);
    if (!bar) return null;
    const box = this.scroller.getBoundingClientRect();
    const left = box.left - this.scroller.scrollLeft;
    const top = box.top + HEAD + i * ROW - this.scroller.scrollTop;
    const x0 = left + this.scale.x(bar.d0);
    const x1 = left + this.scale.x(bar.d1);
    const dot = dotAt(bar, this.scale);
    return { x: (x0 + x1) / 2, y: top + bar.top + bar.h / 2, x0, x1, dot: { x: left + dot.x, y: top + dot.y } };
  }

  private compute(): Analysis {
    this.recomputes++;
    return analyze(this.st);
  }

  private onStore(label?: string) {
    // Notes changing under a drag wait for the drop: previews always start from the store.
    if (this.shown) return;
    const before = this.a;
    const had = Object.keys(before.by).length > 0;
    this.a = this.compute();
    if (had) this.message = describeChanges(this.st, before, this.a, label);
    this.ui = pruneUi(this.ui, this.st);
    this.rebuild();
    if (!this.centred) this.centreToday();
  }

  private gestureHost(): GestureHost {
    const app = this;
    return {
      el: this.scroller,
      get state() {
        return app.store.state;
      },
      get analysis() {
        return app.stored ?? app.a;
      },
      get scene() {
        return app.scene;
      },
      get scale() {
        return app.scale;
      },
      spot: e => this.spotAt(e),
      hit: e => this.hitAt(e),
      preview: st => this.preview(st),
      commit: edit => this.commit(edit),
      consequence: (label, edit) => this.consequence(label, edit),
      say: text => this.say(text),
      paintHot: hot => {
        this.hot = hot;
        this.paint();
      },
    };
  }

  /** Recalculates live without storing. Rows and chart span hold still, so nothing shifts. */
  private preview(st: State | null) {
    if (!st) {
      if (!this.shown) return;
      this.shown = null;
      this.a = this.stored!;
      this.stored = null;
      // Notes that changed mid-drag were held back.
      const { message } = this;
      this.onStore();
      this.message = message;
      return this.renderStatus();
    }
    this.stored ??= this.a;
    this.shown = st;
    this.a = this.compute();
    this.rebuild();
  }

  private commit(edit: Edit) {
    if (this.shown) {
      this.shown = null;
      this.a = this.stored!;
      this.stored = null;
    }
    if (!this.store.apply(edit)) this.onStore();
  }

  /** The status bar line for an edit, before making it. Without an edit, for the schedule on show. */
  private consequence(label: string, edit?: Edit): string {
    const before = this.stored ?? this.a;
    if (!edit) return describeChanges(this.st, before, this.a, label);
    const draft = structuredClone(this.store.state);
    edit(draft);
    return describeChanges(draft, before, analyze(draft), label);
  }

  private say(text: string) {
    this.message = text;
    this.renderStatus();
  }

  private renderStatus() {
    render(<StatusBar st={this.st} a={this.a} message={this.message} onCapacity={h => this.store.apply(setWeekly(h))} />, this.status);
  }

  private setUi(next: UiState) {
    const prev = this.ui;
    this.ui = next;
    if (next.focus !== prev.focus) this.scroller.scrollTop = 0;
    const rebuilt = next.collapsed !== prev.collapsed || next.hidden !== prev.hidden || next.show !== prev.show || next.plan !== prev.plan || next.fc !== prev.fc;
    if (next.focus !== prev.focus || rebuilt) return this.rebuild();
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
    const target = planTarget(st, a, ui);
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
        onLayer={(layer, level) => this.setUi(setLayer(this.ui, layer, level))}
        onView={{
          toggle: () => this.setUi({ ...this.ui, viewOpen: !this.ui.viewOpen }),
          set: (key, on) => this.setUi(setShow(this.ui, key, on)),
          clean: () => this.setUi(cleanForSharing(this.ui)),
          reset: () => {
            this.setUi(defaultView(this.ui));
            // A wider chart clamps the scroll, and narrowing it does not give that back.
            this.centreToday();
          },
        }}
        planName={target.name}
        canPlan={target.rows.length > 0}
        onPlan={() => this.openPlanDialog()}
        undoLabel={this.store.undoLabel}
        onUndo={() => this.undo()}
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
        previewing={!!this.shown}
        act={{
          select: id => this.selectAndReveal(id),
          focus: id => this.focusOn(id),
          openNote: path => this.view.openNote(path),
          apply: edit => void this.store.apply(edit),
          openPlan: () => this.openPlanDialog(),
          openHistory: () => this.setUi({ ...this.ui, historyOpen: true }),
        }}
      />,
      this.rail,
    );
    this.renderStatus();
    this.renderWeekEdit();
    this.renderDialog();
  }

  private openPlanDialog() {
    this.setUi(openPlan(this.ui, this.st, this.a));
  }

  private applyPlan() {
    const dlg = this.ui.planDlg;
    if (!dlg) return;
    this.setUi({ ...this.ui, planDlg: null });
    if (!this.store.apply(updatePlan(dlg.rows.filter(id => dlg.ids.has(id)), dlg.deep))) this.say('Nothing to update: those rows have no dates');
  }

  private renderDialog() {
    const { st, a, ui } = this;
    const close = () => this.setUi({ ...this.ui, planDlg: null, historyOpen: false });
    render(
      ui.planDlg ? (
        <PlanDialogBox
          st={st}
          a={a}
          dlg={ui.planDlg}
          onToggle={id => this.setUi(togglePlanRow(this.ui, id))}
          onDeep={deep => this.setUi(setPlanDeep(this.ui, deep))}
          onApply={() => this.applyPlan()}
          onCancel={close}
          onHistory={() => this.setUi({ ...this.ui, planDlg: null, historyOpen: true })}
        />
      ) : ui.historyOpen ? (
        <HistoryDialog st={st} onClose={close} />
      ) : null,
      this.dialog,
    );
  }

  private renderWeekEdit() {
    const week = this.ui.weekEdit;
    const row = week != null ? this.load.weeks.find(w => w.week === week) : undefined;
    render(
      row ? (
        <WeekEdit
          key={week}
          week={row.week}
          value={row.override}
          weekly={this.st.settings.weekly}
          left={Math.max(4, Math.min(this.scale.x(row.start) - this.scroller.scrollLeft, this.chart.clientWidth - WEEK_EDIT_W))}
          onCommit={hours => this.commitWeek(row.week, hours)}
        />
      ) : null,
      this.overlay,
    );
  }

  private commitWeek(week: number, hours: number | null) {
    // Leaving the field also lands here, and Esc has already closed it by then.
    if (this.ui.weekEdit !== week) return;
    this.setUi({ ...this.ui, weekEdit: null });
    this.store.apply(setWeekCapacity(week, hours));
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
      hot: this.hot,
    });
  }

  /** Chart position among the rows, or null over the axis or the load strip. */
  private spotAt(e: MouseEvent): Spot {
    const box = this.scroller.getBoundingClientRect();
    const y = e.clientY - box.top;
    if (y < HEAD || y > this.chart.clientHeight - this.loadHeight) return null;
    return { x: e.clientX - box.left + this.scroller.scrollLeft, y: y - HEAD + this.scroller.scrollTop };
  }

  private hitAt(e: MouseEvent): Bar | null {
    const p = this.spotAt(e);
    return p ? hitTest(this.scene, this.scale, p.x, p.y) : null;
  }

  /** The load strip week under the pointer. */
  private weekAt(e: MouseEvent): LoadWeek | null {
    if (!this.ui.show.load) return null;
    const box = this.scroller.getBoundingClientRect();
    if (e.clientY - box.top <= this.chart.clientHeight - this.loadHeight) return null;
    return loadWeekAt(this.load, e.clientX - box.left + this.scroller.scrollLeft, this.scale);
  }

  private hideTip() {
    this.tip.style.display = 'none';
  }

  private showTip(id: string, e: MouseEvent) {
    const [title, ...lines] = tooltipLines(this.st, this.a, id);
    this.tipLines(title, lines, e);
  }

  private tipLines(title: string, lines: string[], e: MouseEvent) {
    const { tip } = this;
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

  private onScroll() {
    this.schedulePaint();
    if (this.ui.weekEdit != null) this.setUi({ ...this.ui, weekEdit: null });
  }

  private onPointerMove(e: PointerEvent) {
    if (this.gestures.move(e)) return this.hideTip();
    const week = this.weekAt(e);
    if (week) {
      this.gestures.hover(null, null);
      this.scroller.style.cursor = 'pointer';
      const hours = week.override != null ? `${h1(week.override)}h override` : `${h1(week.cap)}h`;
      return this.tipLines(`CW${isoWeekKey(week.week).slice(-2)}`, [`Capacity ${hours}, ${h1(week.total)}h booked`, 'Click to edit'], e);
    }
    const bar = this.hitAt(e);
    this.scroller.style.cursor = this.gestures.hover(e, bar);
    if (bar) this.showTip(bar.id, e);
    else this.hideTip();
  }

  private listen() {
    const { signal } = this.stop;
    const { scroller, tree } = this;
    this.hierarchy.listen(signal);
    this.root.addEventListener(
      'pointerdown',
      e => {
        if (this.ui.viewOpen && !(e.target as HTMLElement).closest('.tm-view-wrap')) this.setUi({ ...this.ui, viewOpen: false });
      },
      { capture: true, signal },
    );
    scroller.addEventListener('scroll', () => this.onScroll(), { passive: true, signal });
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
      'pointerdown',
      e => {
        this.hideTip();
        this.gestures.down(e);
      },
      { signal },
    );
    scroller.addEventListener('pointerup', e => this.gestures.up(e), { signal });
    scroller.addEventListener('pointercancel', () => this.gestures.cancel(), { signal });
    scroller.addEventListener('pointermove', e => this.onPointerMove(e), { signal });
    scroller.addEventListener(
      'pointerleave',
      () => {
        this.hideTip();
        if (!this.gestures.active) this.gestures.hover(null, null);
      },
      { signal },
    );
    scroller.addEventListener(
      'click',
      e => {
        if (this.gestures.takeClick()) return;
        const week = this.weekAt(e);
        if (week) return this.setUi({ ...this.ui, weekEdit: week.week });
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
