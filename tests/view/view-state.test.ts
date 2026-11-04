import { describe, expect, it } from 'vitest';
import { VIEW_TOGGLES } from '../../src/view/view-menu-items';
import { cleanForSharing, DEFAULT_SHOW, defaultUi, defaultView, escape, layers, setLayer, setShow, type LayerLevel, type UiState } from '../../src/view/ui-state';
import { state, task } from '../engine/helpers';

const LEVELS: LayerLevel[] = ['off', 'ghost', 'solid'];
const ui = (plan: LayerLevel, fc: LayerLevel): UiState => ({ ...defaultUi(), plan, fc });

describe('Plan and Forecast visibility', () => {
  it('moves a layer to a free level', () => {
    expect(setLayer(defaultUi(), 'fc', 'off')).toMatchObject({ plan: 'solid', fc: 'off' });
    expect(setLayer(ui('solid', 'off'), 'plan', 'ghost')).toMatchObject({ plan: 'ghost', fc: 'off' });
  });

  it('swaps when the level is taken', () => {
    expect(setLayer(defaultUi(), 'fc', 'solid')).toMatchObject({ plan: 'ghost', fc: 'solid' });
    expect(setLayer(defaultUi(), 'plan', 'ghost')).toMatchObject({ plan: 'ghost', fc: 'solid' });
    expect(setLayer(ui('ghost', 'off'), 'plan', 'off')).toMatchObject({ plan: 'off', fc: 'ghost' });
  });

  it('never lets the two share a level, Off included', () => {
    for (const plan of LEVELS)
      for (const fc of LEVELS) {
        if (plan === fc) continue;
        for (const pick of LEVELS) {
          const a = setLayer(ui(plan, fc), 'plan', pick);
          const b = setLayer(ui(plan, fc), 'fc', pick);
          expect(a.plan).toBe(pick);
          expect(b.fc).toBe(pick);
          expect(a.plan).not.toBe(a.fc);
          expect(b.plan).not.toBe(b.fc);
        }
      }
  });

  it('picking the level a layer is on changes nothing', () => {
    expect(setLayer(defaultUi(), 'plan', 'solid')).toMatchObject({ plan: 'solid', fc: 'ghost' });
  });

  it('picking Ghost brings a hidden ghost layer back, so the control tells the truth', () => {
    const hidden = setShow(ui('solid', 'off'), 'ghost', false);
    expect(setLayer(hidden, 'fc', 'ghost').show.ghost).toBe(true);
    expect(setLayer(hidden, 'plan', 'off').show.ghost).toBe(false);
    expect(setLayer(setShow(defaultUi(), 'ghost', false), 'plan', 'off').show.ghost).toBe(false);
    expect(setLayer(setShow(ui('ghost', 'solid'), 'ghost', false), 'plan', 'solid').show.ghost).toBe(true);
  });
});

describe('the ghost toggle', () => {
  it('hides the ghost and leaves the levels alone', () => {
    const off = setShow(defaultUi(), 'ghost', false);
    expect(off).toMatchObject({ plan: 'solid', fc: 'ghost' });
    expect(layers(off)).toEqual({ solid: 'plan', ghost: null });
  });
});

describe('View menu', () => {
  it('offers every switch, and nothing else', () => {
    expect(VIEW_TOGGLES.map(t => t.key).sort()).toEqual(Object.keys(DEFAULT_SHOW).sort());
    expect(VIEW_TOGGLES.map(t => t.label)).toEqual(
      expect.arrayContaining(['External items', 'Today line', 'Dependencies', 'Critical chain', 'Capacity links', 'Deadlines', 'Pinned edges', 'Milestones', 'Weekend shading', 'Gridlines', 'Load strip', 'Done and vs-plan columns', 'Conflict markers', 'Legend', 'Right rail', 'Status bar', 'Hide toggles', 'Ghost layer']),
    );
  });

  it('starts with capacity links off and the rest on', () => {
    const { cap, ...rest } = DEFAULT_SHOW;
    expect(cap).toBe(false);
    expect(Object.values(rest).every(Boolean)).toBe(true);
  });

  it('switches one element', () => {
    const next = setShow(defaultUi(), 'legend', false);
    expect(next.show).toEqual({ ...DEFAULT_SHOW, legend: false });
  });

  it('Esc closes it, before anything else', () => {
    const st = state({ a: task('a', 8) }, [['a']]);
    const open = { ...defaultUi(), viewOpen: true, sel: 'a' };
    expect(escape(open, st)).toMatchObject({ viewOpen: false, sel: 'a' });
  });
});

describe('Clean for sharing', () => {
  it('hides everything and closes the menu', () => {
    const c = cleanForSharing({ ...defaultUi(), viewOpen: true });
    expect(Object.values(c.show).some(Boolean)).toBe(false);
    expect(c.viewOpen).toBe(false);
  });

  it('keeps whichever layer is solid and turns the other off', () => {
    expect(cleanForSharing(ui('solid', 'ghost'))).toMatchObject({ plan: 'solid', fc: 'off' });
    expect(cleanForSharing(ui('ghost', 'solid'))).toMatchObject({ plan: 'off', fc: 'solid' });
    expect(cleanForSharing(ui('off', 'solid'))).toMatchObject({ plan: 'off', fc: 'solid' });
  });

  it('with no solid layer, makes the visible one solid, so the chart is never blank', () => {
    expect(cleanForSharing(ui('ghost', 'off'))).toMatchObject({ plan: 'solid', fc: 'off' });
    expect(cleanForSharing(ui('off', 'ghost'))).toMatchObject({ plan: 'off', fc: 'solid' });
  });

  it('every reachable combination leaves exactly one solid layer on show', () => {
    for (const plan of LEVELS)
      for (const fc of LEVELS) {
        if (plan === fc) continue;
        const l = layers(cleanForSharing(ui(plan, fc)));
        expect(l.solid).not.toBeNull();
        expect(l.ghost).toBeNull();
      }
  });

  it('leaves hidden rows and focus alone', () => {
    const c = cleanForSharing({ ...defaultUi(), focus: 'p', hidden: new Set(['q']) });
    expect(c.focus).toBe('p');
    expect([...c.hidden]).toEqual(['q']);
  });
});

describe('Default', () => {
  it('restores everything, with Plan Solid and Forecast Ghost', () => {
    const d = defaultView({ ...cleanForSharing(ui('off', 'solid')), viewOpen: true });
    expect(d.show).toEqual(DEFAULT_SHOW);
    expect(d).toMatchObject({ plan: 'solid', fc: 'ghost', viewOpen: false });
    expect(d.show.cap).toBe(false);
  });
});
