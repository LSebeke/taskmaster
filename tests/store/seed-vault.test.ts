import { describe, expect, it } from 'vitest';
import { vaultFrom } from '../../dev/vault';
import { seed } from '../../dev/seed';
import { analyze } from '../../src/engine';
import { TaskmasterStore } from '../../src/store';

describe('harness vault', () => {
  it('schedules through notes and the real store exactly as the seed does directly', async () => {
    const st = seed();
    const { vault, pathOf } = vaultFrom(st);
    const store = new TaskmasterStore(vault.app, { today: () => st.today });
    await store.load();
    const direct = analyze(st);
    const stored = analyze(store.state);
    for (const id in st.items) {
      const { start, end, spent, left } = direct.by[id];
      expect(stored.by[pathOf(id)], id).toMatchObject({ start, end, spent, left });
    }
    expect(stored.conflicts.length).toBe(direct.conflicts.length);
    expect(store.warnings).toEqual([]);
    store.dispose();
  });
});
