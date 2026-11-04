import { accuracy, adjusted, externalImpact, mvp, rootOf, type Analysis, type Day, type MvpSignal, type State } from '../engine';

export interface Estimate {
  ratio: number;
  /** Hours of estimate the ratio rests on. */
  sample: number;
  finish: Day | null;
}

export type ExternalEffect = ReturnType<typeof externalImpact>;

/** Results kept. Enough for moving between panels and for undo, small against a day's editing. */
const KEEP = 64;

/** 53 bits, so keys stay short however large the vault. */
function hash(text: string): string {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}

/**
 * MVP, adjusted finish and external effect each rerun the schedule, so they run only when a panel on
 * screen asks, once per input hash. `frozen` is a live drag: it keeps the last result on screen.
 */
export class Signals {
  /** Times a signal really ran. */
  runs = 0;

  private cache = new Map<string, unknown>();
  private last = new Map<string, unknown>();
  /** A new analysis is the only time inputs can have changed, so each one is hashed once. */
  private hashes = new WeakMap<Analysis, string>();

  mvp(st: State, a: Analysis, root: string, frozen = false): MvpSignal {
    return this.run(`mvp ${root}`, st, a, frozen, () => mvp(st, root));
  }

  /** For the project `id` is in. */
  estimate(st: State, a: Analysis, id: string, frozen = false): Estimate | null {
    const root = rootOf(st, id);
    return this.run(`estimate ${root}`, st, a, frozen, () => {
      const acc = accuracy(st, root, a.kids);
      return acc && { ...acc, finish: adjusted(st, root, acc.ratio) };
    });
  }

  external(st: State, a: Analysis, id: string, frozen = false): ExternalEffect {
    return this.run(`external ${id}`, st, a, frozen, () => externalImpact(st, id));
  }

  private inputs(st: State, a: Analysis): string {
    let h = this.hashes.get(a);
    if (h == null) {
      h = hash(JSON.stringify([st.items, st.tiers, st.settings, st.today]));
      this.hashes.set(a, h);
    }
    return h;
  }

  private run<T>(name: string, st: State, a: Analysis, frozen: boolean, compute: () => T): T {
    if (frozen && this.last.has(name)) return this.last.get(name) as T;
    const key = `${name} ${this.inputs(st, a)}`;
    if (!this.cache.has(key)) {
      this.runs++;
      this.cache.set(key, compute());
      if (this.cache.size > KEEP) this.cache.delete(this.cache.keys().next().value!);
    }
    const value = this.cache.get(key) as T;
    this.last.set(name, value);
    return value;
  }
}
