import type { App } from 'obsidian';
import type { RunningTimer, State } from '../engine';
import type { Edit } from '../store/edits';
import { HoursLeftModal } from './prompts';

/** What the timer's UI needs of the store. */
export interface TimerStore {
  readonly state: State;
  readonly timer: RunningTimer | null | undefined;
  /** The store's clock. */
  time(): number;
  stopTimer(): { id: string; hours: number; level: number } | null;
  apply(edit: Edit): boolean;
  subscribe(listener: () => void): () => void;
}

const TICK_MS = 15_000;

/** `h:mm`. */
export function elapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

export const timerText = (st: Pick<State, 'items'>, t: RunningTimer, now: number) => `⏱ ${st.items[t.id].title} ${elapsed(now - t.since)}`;

/** Stops the timer and asks for hours left, if anything was logged. */
export function stopAndAsk(app: App, store: Pick<TimerStore, 'state' | 'stopTimer' | 'apply'>) {
  const stopped = store.stopTimer();
  if (stopped?.hours) new HoursLeftModal(app, store, stopped).open();
}

/**
 * Keeps an element saying what runs while no view shows it, so the timer appears once. `inView` is
 * whether a view does; `onLayout` is how to hear that this may have changed. Returns the stop.
 */
export function watchTimer(el: HTMLElement, store: TimerStore, inView: () => boolean, onLayout: (show: () => void) => void): () => void {
  const show = () => {
    const t = inView() ? null : store.timer;
    el.textContent = t ? timerText(store.state, t, store.time()) : '';
    el.style.display = t ? '' : 'none';
  };
  show();
  onLayout(show);
  const off = store.subscribe(show);
  const tick = setInterval(show, TICK_MS);
  return () => {
    off();
    clearInterval(tick);
  };
}
