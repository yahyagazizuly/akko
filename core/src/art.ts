/**
 * The drawing. A box whose class is the current pose holds the shadow and the body. Every part that moves on its
 * own (legs, arms, head, eyes, props…) is an HTML box with a small SVG inside, all laid over the same 72 x 104
 * grid. Browsers move HTML boxes on the GPU without redrawing them, which SVG groups cannot do, so a pose
 * change or a walk cycle costs next to nothing. Gear is swapped in place.
 *
 * The whole figure is there three times (.rb-v), each copy with its lines nudged a little differently; with
 * ink: "lines" the copies are shown in turn, which is the hand-drawn wobble. Otherwise only the first is used.
 */

import { jitter, VARIANTS } from "./lines";

export type Gear = "none" | "shades" | "tophat" | "bow" | "crown" | "cap" | "phones";

const svg = (inner: string) => `<svg viewBox="24 22 72 104" fill="none" aria-hidden="true">${inner}</svg>`;
const part = (cls: string, inner: string) => `<div class="rb-p ${cls}">${inner}</div>`;

const BODY_GEAR: Partial<Record<Gear, string>> = {
  bow: '<path class="i rb-fill" d="M60 68 l-10 -6 v12 Z M60 68 l10 -6 v12 Z"/>',
};

const HEAD_GEAR: Partial<Record<Gear, string>> = {
  shades: svg('<path class="f" d="M42 38 h16 v7 q0 5 -5 5 h-6 q-5 0 -5 -5 Z M62 38 h16 v7 q0 5 -5 5 h-6 q-5 0 -5 -5 Z"/><path class="i" d="M57 40 h6 M36 40 h6 M78 40 h6"/>'),
  tophat: svg('<path class="i b bg" d="M46 28 V8 h28 V28"/><path class="i b" d="M37 28 h46"/><path class="i rb-ink" d="M47 21 h26"/>'),
  crown: svg('<path class="i rb-fill" d="M44 28 V12 l8 9 l8 -11 l8 11 l8 -9 V28 Z"/>'),
  cap: svg('<path class="i b rb-fill" d="M43 29 Q60 6 77 29 Z"/><path class="i" d="M60 17 V10"/>') + part("rb-spin", svg('<path class="i b" d="M48 9 h24"/>')),
  phones: svg('<path class="i b" d="M35 42 V38 Q35 18 60 18 Q85 18 85 38 V42"/><rect class="f" x="29" y="38" width="8" height="15" rx="3.5"/><rect class="f" x="83" y="38" width="8" height="15" rx="3.5"/>'),
};

const jug = part("rb-jug", svg('<circle class="i rb-fill" cx="60" cy="64" r="5"/>'));

const copies = (f: (k: number) => string) => Array.from({ length: VARIANTS }, (_, k) => part("rb-v", f(k))).join("");

const SHADOW = svg('<ellipse cx="60" cy="123" rx="22" ry="3"/>');
const FIGURE = [
  part("rb-z", svg('<path class="i" d="M88 30 h8 l-8 9 h8"/>')),
  part("rb-prop rb-jet",
    part("rb-fire", svg('<path class="i" d="M27 99 q5 14 5 20 q0 -6 5 -20"/>')) +
    svg('<rect class="i b bg" x="25" y="70" width="14" height="30" rx="6"/>')),
  part("rb-prop rb-brolly", svg('<path class="i b rb-fill" d="M16 18 Q60 -34 104 18 Q82 8 60 18 Q38 8 16 18 Z"/><path class="i" d="M60 -8 V18"/>')),
  part("rb-prop rb-balloon", svg('<path class="i b" d="M82 78 C92 72 95 62 93 52"/><path class="i" d="M93 52 C98 42 88 34 92 24"/><ellipse class="i rb-fill" cx="92" cy="4" rx="15" ry="19"/><path class="i" d="M89 23 l3 4 l3 -4"/>')),
  part("rb-body",
    part("rb-leg l", svg('<path class="i b" d="M50 105 V119 M44 120.5 h11"/>')) +
    part("rb-leg r", svg('<path class="i b" d="M70 105 V119 M65 120.5 h11"/>')) +
    part("rb-arm l", svg('<path class="i b" d="M38 78 C29 84 29 92 32 98"/>')) +
    part("rb-arm r", svg('<path class="i b" d="M82 78 C91 84 91 92 88 98"/>')) +
    part("rb-reach", svg('<path class="i b" d="M39 76 C29 62 29 38 33 17 M81 76 C91 62 91 38 87 17"/>')) +
    svg('<rect class="i b bg" x="38" y="66" width="44" height="40" rx="13"/><path class="i s" d="M50 80 h20 M50 89 h12"/><path class="i b" d="M60 66 V61"/><g class="rb-gear-body"></g>')),
  part("rb-head",
    svg('<rect class="i b bg" x="35" y="28" width="50" height="34" rx="14"/>') +
    part("rb-eyes",
      part("rb-eye", svg('<ellipse class="f" cx="52" cy="44" rx="3.6" ry="4.6"/>')) +
      part("rb-eye", svg('<ellipse class="f" cx="68" cy="44" rx="3.6" ry="4.6"/>'))) +
    part("rb-mouth", svg('<path class="i" d="M54 53 Q60 57 66 53"/>')) +
    part("rb-gear-head", "")),
  part("rb-prop rb-balls", jug + jug + jug),
  part("rb-prop rb-stars", part("rb-orbit", svg('<path class="i" d="M42 14 l2 -4 l2 4 l4 2 l-4 2 l-2 4 l-2 -4 l-4 -2 Z"/><path class="i" d="M74 10 l2 4 l4 2 l-4 2 l-2 4 l-2 -4 l-4 -2 l4 -2 Z"/><path class="i" d="M60 -2 v1 M60 31 v1"/>'))),
  part("rb-bang", svg('<path class="i" d="M100 34 v12 M100 53 v1"/>')),
].join("");

export const ART = `
<div class="chelik-art rb is-idle">
${part("rb-shadow", copies((k) => jitter(SHADOW, k, 900)))}
<div class="rb-all">${copies((k) => jitter(FIGURE, k))}${part("rb-exhaust", "<i></i>".repeat(5))}</div>
</div>
<div class="rb-hit"></div>`;

/**
 * The "boiling ink" noise filters the art cycles through (only used with ink: "filter"). The filter area reaches
 * well past his box, because props (balloon, umbrella, raised arms) are drawn outside it.
 */
export const FILTERS = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
${[4, 13, 29].map((seed, i) => `<filter id="chelik-boil-${i + 1}" x="-60%" y="-60%" width="220%" height="220%">
  <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="${seed}" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="2.4" xChannelSelector="R" yChannelSelector="G"/>
</filter>`).join("")}
</defs></svg>`;

export function renderGear(art: Element, gear: Gear) {
  art.querySelectorAll(".rb-gear-body").forEach((g, k) => { g.innerHTML = jitter(BODY_GEAR[gear] ?? "", k, 700); });
  art.querySelectorAll(".rb-gear-head").forEach((g, k) => { g.innerHTML = jitter(HEAD_GEAR[gear] ?? "", k, 800); });
}
