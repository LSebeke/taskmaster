import type { Todo } from '../engine';

const TASK = /^([\s>]*(?:[-*+]|\d+[.)])\s+\[)(.)\](?:\s+|$)/;
const FENCE = /^\s*(`{3,}|~{3,})/;

interface TaskLine extends Todo {
  /** Offset of the character between the brackets. */
  mark: number;
  start: number;
  end: number;
}

/** Checkbox lines of a whole note, read as the cache lists them: not in frontmatter or code fences. */
function taskLines(text: string): TaskLine[] {
  const out: TaskLine[] = [];
  let fence: string | null = null;
  let yaml = /^---\r?\n/.test(text);
  let start = 0;
  for (let n = 0; start <= text.length; n++) {
    const nl = text.indexOf('\n', start);
    const end = nl < 0 ? text.length : nl + 1;
    const line = text.slice(start, end).replace(/\r?\n$/, '');
    const f = FENCE.exec(line)?.[1];
    if (yaml) yaml = n === 0 || line !== '---';
    else if (fence) {
      if (f?.startsWith(fence)) fence = null;
    } else if (f) fence = f;
    else {
      const m = TASK.exec(line);
      if (m) out.push({ t: line.slice(m[0].length), done: m[2] !== ' ', mark: start + m[1].length, start, end });
    }
    if (nl < 0) break;
    start = end;
  }
  return out;
}

export const parseTodos = (text: string): Todo[] => taskLines(text).map(({ t, done }) => ({ t, done }));

/** The task an index and text mean now. The note may have changed since the panel read it. */
function find(tasks: TaskLine[], index: number, t: string) {
  return tasks[index]?.t === t ? tasks[index] : tasks.find(x => x.t === t);
}

/** Nothing changes if the to-do is gone. */
export function tickInText(text: string, index: number, t: string, done: boolean): string {
  const task = find(taskLines(text), index, t);
  if (!task || task.done === done) return text;
  return text.slice(0, task.mark) + (done ? 'x' : ' ') + text.slice(task.mark + 1);
}

/** After the last to-do, in its style, else at the end of the note. */
export function addToText(text: string, t: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const last = taskLines(text).at(-1);
  if (!last) return `${text}${text && !text.endsWith('\n') ? eol : ''}- [ ] ${t}${eol}`;
  const line = `${text.slice(last.start, last.mark)} ] ${t}`;
  if (text.slice(last.start, last.end).endsWith('\n')) return `${text.slice(0, last.end)}${line}${eol}${text.slice(last.end)}`;
  return `${text}${eol}${line}`;
}

/** Nothing changes if the to-do is gone. */
export function removeFromText(text: string, index: number, t: string): string {
  const task = find(taskLines(text), index, t);
  if (!task) return text;
  const lastLine = !text.slice(task.start, task.end).endsWith('\n');
  const start = lastLine ? text.slice(0, task.start).replace(/\r?\n$/, '').length : task.start;
  return text.slice(0, start) + text.slice(task.end);
}
