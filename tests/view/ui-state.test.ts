import { describe, expect, it } from 'vitest';
import { defaultUi, escape, goUp, layers, openForm, pruneUi, rekeyUi, setFocus, toggleCollapsed, toggleHidden, type UiState } from '../../src/view/ui-state';
import { state, task } from '../engine/helpers';

const st = state({ p: task('p', 0), 'p.g': task('g', 0, { parent: 'p' }), 'p.g.t': task('t', 8, { parent: 'p.g' }), q: task('q', 8) }, [['p.g.t', 'q']]);

describe('escape with a week being edited', () => {
  it('closes it first', () => {
    const st = { items: {} } as never;
    const ui = { ...defaultUi(), weekEdit: 3, hiddenOpen: true };
    expect(escape(ui, st)).toMatchObject({ weekEdit: null, hiddenOpen: true });
  });
});

describe('navigation', () => {
  it('Esc closes the hidden list first, then clears selection, then goes up, then rests', () => {
    let ui: UiState = { ...defaultUi(), focus: 'p.g', sel: 'p.g.t', hiddenOpen: true };
    ui = escape(ui, st);
    expect(ui).toMatchObject({ hiddenOpen: false, sel: 'p.g.t', focus: 'p.g' });
    ui = escape(ui, st);
    expect(ui).toMatchObject({ sel: null, focus: 'p.g' });
    ui = escape(ui, st);
    expect(ui).toMatchObject({ sel: null, focus: 'p' });
    ui = escape(ui, st);
    expect(ui.focus).toBeNull();
    expect(escape(ui, st)).toEqual(ui);
  });

  it('Up goes to the parent and clears selection', () => {
    expect(goUp({ ...defaultUi(), focus: 'p.g', sel: 'p.g.t' }, st)).toMatchObject({ focus: 'p', sel: null });
    expect(goUp(defaultUi(), st).focus).toBeNull();
  });

  it('focusing expands the item and clears selection', () => {
    const ui = setFocus({ ...defaultUi(), sel: 'q', collapsed: new Set(['p.g']) }, 'p.g');
    expect(ui.focus).toBe('p.g');
    expect(ui.sel).toBeNull();
    expect(ui.collapsed.has('p.g')).toBe(false);
  });
});

describe('collapse and eye', () => {
  it('toggles collapse', () => {
    const ui = toggleCollapsed(defaultUi(), 'p');
    expect(ui.collapsed.has('p')).toBe(true);
    expect(toggleCollapsed(ui, 'p').collapsed.has('p')).toBe(false);
  });

  it('hiding clears a selection inside the hidden subtree, and leaves others alone', () => {
    expect(toggleHidden({ ...defaultUi(), sel: 'p.g.t' }, 'p', st)).toMatchObject({ sel: null });
    expect(toggleHidden({ ...defaultUi(), sel: 'q' }, 'p', st)).toMatchObject({ sel: 'q' });
  });

  it('closes the hidden list when its last row comes back', () => {
    const ui = { ...defaultUi(), hidden: new Set(['q']), hiddenOpen: true };
    const back = toggleHidden(ui, 'q', st);
    expect(back.hidden.size).toBe(0);
    expect(back.hiddenOpen).toBe(false);
  });
});

describe('after the store changes', () => {
  it('drops a focus, selection and hidden row whose item is gone', () => {
    const ui = pruneUi({ ...defaultUi(), focus: 'nope', sel: 'gone', hidden: new Set(['q', 'gone']) }, st);
    expect(ui).toMatchObject({ focus: null, sel: null });
    expect([...ui.hidden]).toEqual(['q']);
  });

  it('returns the same object when nothing went away', () => {
    const ui = { ...defaultUi(), focus: 'p', hidden: new Set(['q']) };
    expect(pruneUi(ui, st)).toBe(ui);
  });
});

describe('layers', () => {
  it('defaults to Plan Solid, Forecast Ghost', () => {
    expect(layers(defaultUi())).toEqual({ solid: 'plan', ghost: 'fc' });
  });

  it('reads each combination', () => {
    expect(layers({ ...defaultUi(), plan: 'ghost', fc: 'solid' })).toEqual({ solid: 'fc', ghost: 'plan' });
    expect(layers({ ...defaultUi(), plan: 'off', fc: 'solid' })).toEqual({ solid: 'fc', ghost: null });
  });
});

describe('ids the state no longer has count as none', () => {
  const gone = 'Projects/gone.md';

  it('Up from a focus that went away goes to the top', () => {
    expect(goUp({ ...defaultUi(), focus: gone }, st).focus).toBeNull();
  });

  it('the add form ignores a selection that went away', () => {
    const ui = openForm({ ...defaultUi(), sel: gone, focus: 'p' }, st, {}, 'item');
    expect(ui.form?.parent).toBe('p');
  });

  it('pruning clears every kind of reference', () => {
    const ui = pruneUi(
      {
        ...defaultUi(),
        sel: gone,
        focus: gone,
        collapsed: new Set([gone, 'p']),
        hidden: new Set([gone]),
        todoOpen: new Set([gone, 'q']),
        form: { kind: 'item', parent: gone, last: gone, added: [], nonce: 1 },
      },
      st,
    );
    expect(ui).toMatchObject({ sel: null, focus: null, form: { parent: null, last: null } });
    expect([...ui.collapsed]).toEqual(['p']);
    expect([...ui.hidden]).toEqual([]);
    expect([...ui.todoOpen]).toEqual(['q']);
  });

  it('pruning a clean state changes nothing, so nothing rebuilds', () => {
    const ui = { ...defaultUi(), sel: 'q', collapsed: new Set(['p']) };
    expect(pruneUi(ui, st)).toBe(ui);
  });
});

describe('a move rekeys everything the view holds', () => {
  it('note and folder renames both reach selection, focus, form, collapsed, hidden and open to-dos', () => {
    const ui = rekeyUi(
      {
        ...defaultUi(),
        sel: 'a/x.md',
        focus: 'a/x.md',
        collapsed: new Set(['a/x.md']),
        hidden: new Set(['a/x.md']),
        todoOpen: new Set(['a/x.md']),
        form: { kind: 'item', parent: 'a/x.md', last: 'a/x.md', added: [], nonce: 1 },
      },
      'a',
      'b',
    );
    expect(ui).toMatchObject({ sel: 'b/x.md', focus: 'b/x.md', form: { parent: 'b/x.md', last: 'b/x.md' } });
    expect([...ui.collapsed, ...ui.hidden, ...ui.todoOpen]).toEqual(['b/x.md', 'b/x.md', 'b/x.md']);
  });
});
