import { useRef, useState } from 'preact/hooks';
import { leavesOf, rootOf } from '../../engine';
import { addLevel, moveTask, removeLevel } from '../../store/edits';
import { h1 } from '../format';
import { toggleTodoOpen, type UiState } from '../ui-state';
import { Todos, type PanelProps } from './parts';

type TabProps = Omit<PanelProps, 'id'> & { ui: UiState; roots: string[] };

/** Where a drop would land: a level, the task to go before, the insertion line's top inside the level. */
interface Target {
  level: number;
  before: string | null;
  y: number;
}

/** Drag payload type: not text, so dropping on an open note writes nothing into it. */
const DRAG_TYPE = 'application/x-taskmaster-task';

const rect = (e: Element) => e.getBoundingClientRect();

/** The drop a pointer means inside a level. The dragged row is not a position of its own. */
function targetIn(box: HTMLElement, level: number, dragged: string, pointerY: number): Target {
  const all = [...box.querySelectorAll<HTMLElement>('[data-task]')];
  const rows = all.filter(r => r.dataset.task !== dragged);
  const before = rows.find(r => pointerY < rect(r).top + rect(r).height / 2);
  const top = rect(box).top + box.clientTop;
  if (before) return { level, before: before.dataset.task!, y: rect(before).top - top };
  const last = rows.at(-1);
  if (last) return { level, before: null, y: rect(last).bottom - top };
  const slot = all[0] ?? box.querySelector('.tm-level-empty');
  return { level, before: null, y: (slot ? rect(slot).top : rect(box).bottom) - top };
}

interface RowProps extends Omit<TabProps, 'ui' | 'roots'> {
  id: string;
  open: boolean;
  dragged: boolean;
  colour: number;
  onToggle(): void;
  onDragStart(e: DragEvent): void;
  onDragEnd(): void;
}

function TaskRow({ st, a, id, act, readTodos, previewing, open, dragged, colour, onToggle, onDragStart, onDragEnd }: RowProps) {
  const it = st.items[id];
  const b = a.by[id];
  const left = it.todos?.filter(t => !t.done).length ?? 0;
  return (
    <div class={`tm-td${dragged ? ' tm-td-src' : ''}`} data-task={id}>
      {/* Only the head drags, so text in the to-do field can be selected. */}
      <div class="tm-td-hd" draggable onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <button class="tm-td-open" aria-expanded={open} aria-label={`To-dos of ${it.title}`} onClick={onToggle}>
          {open ? '▾' : '▸'}
        </button>
        <span class="tm-dot" style={{ background: `var(--tm-c${(colour % 8) + 1})` }} />
        <span class="tm-grow tm-link tm-td-title" title={it.title} onClick={() => act.select(id)}>
          {it.title}
        </span>
        <span class="tm-num">
          {left > 0 && `☐${left} `}
          {h1(b.left)}h · {h1(b.burn ?? 0)}h/d
        </span>
      </div>
      {open && <Todos st={st} a={a} id={id} act={act} readTodos={readTodos} previewing={previewing} />}
    </div>
  );
}

/** Priority levels as boxes, overall or for the focused project. Levels are global, so a project list shows them all. */
export function TodoTab({ st, a, ui, roots, act, readTodos, previewing }: TabProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Target | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const root = ui.focus ? rootOf(st, ui.focus) : null;
  const all = ui.todoAll || !root;
  const inScope = all ? null : new Set(leavesOf(st, root, a.K));
  // A note can vanish mid-drag, and with it the row that would have ended the drag.
  const live = dragging && st.tiers.some(t => t.includes(dragging)) ? dragging : null;
  const from = live ? st.tiers.findIndex(t => t.includes(live)) : -1;
  const at = live ? over : null;

  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };
  const startDrag = (id: string) => (e: DragEvent) => {
    e.dataTransfer!.setData(DRAG_TYPE, id);
    e.dataTransfer!.effectAllowed = 'move';
    setDragging(id);
  };
  const onDragOver = (e: DragEvent) => {
    if (!live) return;
    const box = (e.target as Element).closest<HTMLElement>('[data-level]');
    if (!box) return setOver(null);
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    const next = targetIn(box, Number(box.dataset.level), live, e.clientY);
    if (next.level !== over?.level || next.before !== over.before || next.y !== over.y) setOver(next);
  };
  const onDragLeave = (e: DragEvent) => {
    if (!panel.current?.contains(e.relatedTarget as Node | null)) setOver(null);
  };
  const onDrop = (e: DragEvent) => {
    if (!live || !at) return;
    e.preventDefault();
    act.apply(moveTask(live, at.level, at.before));
    endDrag();
  };

  return (
    <div ref={panel} class={`tm-lists${live ? ' tm-dragging' : ''}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div class="tm-seg tm-todo-scope" role="group" aria-label="Which list">
        <button class={all ? 'tm-on' : ''} onClick={() => act.ui({ todoAll: true })}>
          All projects
        </button>
        <button class={all ? '' : 'tm-on'} disabled={!root} onClick={() => act.ui({ todoAll: false })}>
          {root ? st.items[root].title : 'This project'}
        </button>
      </div>
      <div class="tm-sub tm-lists-intro">Order inside a level is yours and changes nothing. Dragging into another level changes who gets hours.</div>
      {st.tiers.map((level, i) => {
        const open = level.filter(id => st.items[id] && a.by[id] && !a.by[id].done);
        const rows = inScope ? open.filter(id => inScope.has(id)) : open;
        const same = at?.level === i && from === i;
        const cross = at?.level === i && from !== i;
        return (
          <div class={`tm-level${same ? ' tm-level-same' : ''}${cross ? ' tm-level-cross' : ''}`} data-level={i} key={i}>
            <div class="tm-level-head">
              <b>Priority {i + 1}</b>
              <span class="tm-sub tm-grow">
                {rows.length > 0 && `${rows.length} task${rows.length > 1 ? 's, equal burn' : ''}`}
              </span>
              <button class="tm-level-add" title="New priority level above this one" onClick={() => act.apply(addLevel(i))}>
                + above
              </button>
              {!level.length && (
                <button class="tm-level-remove" title="Remove this empty level" onClick={() => act.apply(removeLevel(i))}>
                  Remove
                </button>
              )}
            </div>
            {!rows.length && <div class="tm-level-empty">{open.length ? 'No tasks from this project' : 'Empty. Drag tasks here'}</div>}
            {rows.map(id => (
              <TaskRow
                key={id}
                st={st}
                a={a}
                id={id}
                act={act}
                readTodos={readTodos}
                previewing={previewing}
                open={ui.todoOpen.has(id)}
                dragged={id === live}
                colour={roots.indexOf(rootOf(st, id))}
                onToggle={() => act.ui(toggleTodoOpen(ui, id))}
                onDragStart={startDrag(id)}
                onDragEnd={endDrag}
              />
            ))}
            {(same || cross) && <div class="tm-insert" style={{ top: `${at!.y}px` }} />}
            {same && <div class="tm-banner">Order only: schedule stays the same</div>}
            {cross && <div class="tm-banner">Moves to Priority {i + 1}: changes who gets hours</div>}
          </div>
        );
      })}
      <button class="tm-level-bottom" onClick={() => act.apply(addLevel(st.tiers.length))}>
        + New priority level at the bottom
      </button>
    </div>
  );
}
