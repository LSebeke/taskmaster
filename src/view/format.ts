import { iso, type Day } from '../engine';

/** Fixed names: `toLocaleDateString` is slow per frame, and spells September differently by ICU version. */
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const fmtD = (d: Day | null | undefined): string => {
  if (d == null) return '—';
  const [, m, day] = iso(d).split('-').map(Number);
  return `${day} ${MONTHS[m - 1]}`;
};

/** Hours to one decimal, no trailing zero. */
export const h1 = (n: number): string => String(Math.round(n * 10) / 10);

/** Note path to its name. */
export const noteName = (path: string): string => path.split('/').pop()!.replace(/\.md$/, '');
