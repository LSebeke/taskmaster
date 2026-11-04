const NAMES = ['surface', 'ink', 'ink2', 'muted', 'grid', 'axis', 'crit', 'accent', 'on-accent', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'] as const;

export type Palette = Record<(typeof NAMES)[number], string> & { font: string };

/** A view can open before Obsidian applies the plugin's stylesheet. Until then every colour reads as the inherited one. */
export const stylesApplied = (root: HTMLElement) => getComputedStyle(root).getPropertyValue('--tm-surface') !== '';

/** Themes define colours with calc() and color-mix(), so a probe element resolves them for the canvas. */
export function readPalette(root: HTMLElement): Palette {
  const probe = root.ownerDocument.createElement('span');
  root.append(probe);
  const out = {} as Palette;
  for (const n of NAMES) {
    probe.style.color = `var(--tm-${n})`;
    out[n] = getComputedStyle(probe).color;
  }
  probe.remove();
  out.font = getComputedStyle(root).fontFamily;
  return out;
}
