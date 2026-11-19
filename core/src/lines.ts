/**
 * "Line boil" without filters: the drawing exists in a few copies whose points are nudged a little differently —
 * the way hand-drawn animation redraws each line slightly differently — and the copies are shown in turn.
 * The nudging is done once, on the markup, before anything is drawn; showing the copies in turn is a plain
 * opacity animation the GPU runs by itself. So the wobble costs nothing while it plays.
 */

const ATTRS: Record<string, number> = { d: 1, x: 0.5, y: 0.5, cx: 0.5, cy: 0.5, width: 0.4, height: 0.4, rx: 0.3, ry: 0.3, r: 0.3 };
const NUM = /-?\d*\.?\d+/g;

/** Repeatable noise in [-1, 1] for (shape, number, variant). */
const noise = (a: number, b: number, k: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7 + k * 74.7) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
};

/** Variant k of some SVG markup: every shape's numbers nudged a little (k = 0 is the drawing as written). */
export function jitter(markup: string, k: number, seed = 0, amount = 0.9): string {
  if (k <= 0) return markup;
  let shape = seed;
  return markup.replace(/<(?:path|rect|ellipse|circle)\b[^>]*>/g, (tag) => {
    shape++;
    let n = 0;
    return tag.replace(/(\s)(d|x|y|cx|cy|width|height|rx|ry|r)="([^"]*)"/g, (_m, sp: string, a: string, v: string) =>
      `${sp}${a}="${v.replace(NUM, (m) => (parseFloat(m) + noise(shape, n++, k) * amount * ATTRS[a]).toFixed(2))}"`);
  });
}

/** How many copies of the drawing there are. */
export const VARIANTS = 3;
