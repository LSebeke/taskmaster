import type { Show } from './ui-state';

/** In the order of the spec's View menu. */
export const VIEW_TOGGLES: { key: keyof Show; label: string }[] = [
  { key: 'ext', label: 'External items' },
  { key: 'today', label: 'Today line' },
  { key: 'deps', label: 'Dependencies' },
  { key: 'crit', label: 'Critical chain' },
  { key: 'cap', label: 'Capacity links' },
  { key: 'deadlines', label: 'Deadlines' },
  { key: 'pins', label: 'Pinned edges' },
  { key: 'milestones', label: 'Milestones' },
  { key: 'nonwork', label: 'Weekend shading' },
  { key: 'grid', label: 'Gridlines' },
  { key: 'load', label: 'Load strip' },
  { key: 'cols', label: 'Done and vs-plan columns' },
  { key: 'conflicts', label: 'Conflict markers' },
  { key: 'legend', label: 'Legend' },
  { key: 'rail', label: 'Right rail' },
  { key: 'status', label: 'Status bar' },
  { key: 'eyes', label: 'Hide toggles' },
  { key: 'ghost', label: 'Ghost layer' },
];
