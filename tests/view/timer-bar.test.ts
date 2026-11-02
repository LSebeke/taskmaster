import { describe, expect, it, vi } from 'vitest';
import { watchTimer } from '../../src/view/timer';

vi.mock('obsidian', () => ({ Modal: class {} }));

describe('the timer in Obsidian\'s status bar', () => {
  const element = () => ({ textContent: '', style: { display: '' } }) as unknown as HTMLElement;
  const timerStore = (running: boolean) => ({ state: { items: { a: { title: 'a' } } }, timer: running ? { id: 'a', since: 0 } : null, time: () => 60_000, subscribe: () => () => undefined }) as never;

  it('says what runs while no view does', () => {
    const el = element();
    const stop = watchTimer(el, timerStore(true), () => false, () => undefined);
    expect(el.textContent).toContain('a');
    expect(el.style.display).toBe('');
    stop();
  });

  it('stays out of the way while a view shows the timer, and comes back when it goes', () => {
    const el = element();
    let inView = true;
    let refresh = () => {};
    const stop = watchTimer(el, timerStore(true), () => inView, show => (refresh = show));
    expect(el.textContent).toBe('');
    expect(el.style.display).toBe('none');
    inView = false;
    refresh();
    expect(el.textContent).toContain('a');
    expect(el.style.display).toBe('');
    stop();
  });

  it('takes no room with nothing running', () => {
    const el = element();
    const stop = watchTimer(el, timerStore(false), () => false, () => undefined);
    expect(el.style.display).toBe('none');
    stop();
  });
});
