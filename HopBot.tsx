"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The little site mascot, drawn in the same boiling ink as the site art. It lives on the bottom edge of the
 * screen and roams the whole viewport. Nothing is scripted in order: every turn it picks one of ~45 acts,
 * strongly preferring the ones it has done least (the tally is kept in localStorage, so each visit starts
 * with something new). It walks with real acceleration and footsteps that match the ground covered, its eyes
 * follow the cursor, and it can be poked, picked up and thrown.
 *
 * - On the floor and on walls it is moved frame by frame (`go`); jumps and flights use the Web Animations API
 *   on the dock's `translate` / `rotate` / `scale`, which are committed to inline style when they finish.
 * - Poses are CSS classes on the svg (".rb" in site.css); the walk cycle is driven through CSS variables.
 * - Page elements are animated with composite "add" so their own transforms are kept. If the page scrolls
 *   mid-trick, the element springs back and the bot drops.
 * - Try one act from the console: `hopbot("jetpack")`; `hopbot()` lists them.
 */

type Gear = "none" | "shades" | "tophat" | "bow" | "crown" | "cap" | "phones";
type Pt = [number, number, number?];
type Act = { w: number; kind?: "top" | "bottom"; fit?: (r: DOMRect) => boolean; ok?: () => boolean; run: (t: HTMLElement) => Promise<void> };
type GoOpts = { speed?: number; pose?: string; face?: boolean; back?: boolean; roll?: number };

const SPEED = 46; // px per second strolling
const RUN = 150; // px per second running
const GRAVITY = 2600; // px per second squared when thrown
const SEEN_KEY = "hopbot:seen";
const GEARS: Gear[] = ["shades", "tophat", "bow", "crown", "cap", "phones", "none"];

// Things on the page it may play with.
const TARGETS = [
  "main h1", "main h2", "main .lp-btn", "main .lp-trio article", "main .lp-models > div", "main .lp-photos figure",
  "main .sc-tabs button", "main .sc-window", "main .ch-win.front", "main .ch-icons button", "main .lp-matrix",
  "main .rs-panel", "main .lp-thread", "main .lp-chart", "main .vd-frame", "main .lp-hero-photo figcaption b",
  "main .lp-plan", "main .lp-faq details", "main .rs-note",
].join(", ");

const STICKERS = [
  '<path d="M15 3 l3.5 7.5 8 1 -6 5.5 1.6 8 -7.1 -4 -7.1 4 1.6 -8 -6 -5.5 8 -1 Z"/>',
  '<path d="M15 26 C6 19 3 14 5 9 c2 -5 8 -5 10 0 c2 -5 8 -5 10 0 c2 5 -1 10 -10 17 Z"/>',
  '<path d="M17 3 L7 17 h7 l-2 10 L23 12 h-7 Z"/>',
  '<circle cx="15" cy="15" r="11"/><path d="M10 17 q5 5 10 0" style="fill:none"/><path d="M11 11 v1 M19 11 v1"/>',
  '<path d="M6 16 l6 6 L25 8" style="fill:none"/>',
  '<path d="M15 4 v22 M4 15 h22 M7 7 l16 16 M23 7 L7 23" style="fill:none"/>',
  '<path d="M5 22 C5 10 12 6 15 6 s10 4 10 16 Z"/><path d="M11 15 v1 M19 15 v1"/>',
];

const SAY = {
  hi: ["hi!", "hey!", "yo!", "o/", "sup"],
  oops: ["oops", "ow!", "oof", "whoa"],
  yay: ["yay!", "ta-da!", "nice!", "woo!", "easy"],
  fly: ["wheee!", "whoosh", "zoom!", "bye!"],
  hmm: ["hmm…", "?", "huh"],
  poke: ["hey!", "eep!", "that tickles", "boop"],
  thrown: ["waaah!", "aaaa!", "not again!", "wheee!"],
  song: ["♪ ♫", "la la ♪", "♫"],
  strain: ["hnnng", "grrr", "nnngh"],
  look: ["new look", "fancy", "✦"],
};

const PAINTS = ["invert(1) hue-rotate(180deg)", "sepia(1) saturate(5) hue-rotate(-18deg)", "grayscale(1) contrast(1.4)", "hue-rotate(150deg) saturate(1.6)", "blur(2.5px)"];

const ID = "translate(0px, 0px)";
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
const coin = (p = 0.5) => Math.random() < p;
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const tr = (x: number, y: number) => `${x.toFixed(1)}px ${y.toFixed(1)}px`;

// Element shapes, all centred so they work on top of the element's own transform.
const squash = (k: number, H: number) => `translateY(${((1 - k) * H / 2).toFixed(1)}px) scale(${(1 + (1 - k) * 0.35).toFixed(3)}, ${k.toFixed(3)})`;
const stretchDown = (k: number, H: number) => `translateY(${((k - 1) * H / 2).toFixed(1)}px) scale(${(1 - (k - 1) * 0.12).toFixed(3)}, ${k.toFixed(3)})`;
const stretchRight = (k: number, W: number) => `translateX(${((k - 1) * W / 2).toFixed(1)}px) scale(${k.toFixed(3)}, ${(1 - (k - 1) * 0.15).toFixed(3)})`;

/** Visible box of an element; for headings, just the text. */
function boxOf(el: HTMLElement): DOMRect {
  if (/^H[1-6]$/.test(el.tagName)) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    if (r.width > 0) return r;
  }
  return el.getBoundingClientRect();
}

/** A one-off shockwave with sparks at a point on screen. */
function burst(host: HTMLElement, x: number, y: number) {
  const el = document.createElement("div");
  el.className = "rb-burst";
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  for (let i = 0; i < 8; i++) {
    const s = document.createElement("i");
    s.style.setProperty("--a", `${i * 45 + (i % 2 ? 0 : 22)}deg`);
    el.appendChild(s);
  }
  host.appendChild(el);
  window.setTimeout(() => el.remove(), 900);
}

/** A short-lived speck (dust, flame) that flies off by (--dx, --dy). */
function fleck(host: HTMLElement, cls: string, x: number, y: number, dx: number, dy: number, ms = 600) {
  const el = document.createElement("i");
  el.className = cls;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.setProperty("--dx", `${dx.toFixed(0)}px`);
  el.style.setProperty("--dy", `${dy.toFixed(0)}px`);
  host.appendChild(el);
  window.setTimeout(() => el.remove(), ms);
}

/** An ink doodle stuck onto an element for a few seconds; it rides along when the page scrolls. */
function stick(host: HTMLElement, target: HTMLElement, x: number, y: number) {
  const el = document.createElement("div");
  el.className = "rb-sticker";
  el.innerHTML = `<svg viewBox="0 0 30 30">${pick(STICKERS)}</svg>`;
  el.style.rotate = `${rand(-18, 18).toFixed(0)}deg`;
  const r0 = target.getBoundingClientRect();
  const dx = x - r0.left, dy = y - r0.top;
  host.appendChild(el);
  const end = performance.now() + 7000;
  const follow = () => {
    const r = target.getBoundingClientRect();
    el.style.left = `${r.left + dx}px`;
    el.style.top = `${r.top + dy}px`;
    if (performance.now() < end) requestAnimationFrame(follow);
    else { el.classList.add("out"); window.setTimeout(() => el.remove(), 450); }
  };
  follow();
}

export default function HopBot() {
  const [pose, setPose] = useState("idle");
  const [left, setLeft] = useState(false);
  const [gear, setGear] = useState<Gear>("none");
  const dock = useRef<HTMLDivElement>(null);
  const art = useRef<SVGSVGElement>(null);
  const grip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = dock.current, svg = art.current, hit = grip.current;
    if (!el || !svg || !hit) return;
    const host = el.parentElement ?? document.body;
    const scroller = el.closest<HTMLElement>(".lp") ?? document.documentElement;
    const page = host.querySelector<HTMLElement>("main");

    let alive = true;
    const timers = new Set<number>();
    /** A plain pause that never throws. */
    const nap = (ms: number) => new Promise<void>((res) => { const t = window.setTimeout(() => { timers.delete(t); res(); }, ms); timers.add(t); });

    // ---- Interruption: a scroll during an element trick, or the user grabbing the bot, aborts the current act.
    const ABORT = new Error("abort");
    const watch = { on: false, start: 0 };
    let grabbed = false;
    const fxAnims = new Set<Animation>();
    const undo = new Set<() => void>(); // cleanups for props an act has left on the page
    const cancelFx = () => { fxAnims.forEach((a) => a.cancel()); fxAnims.clear(); };
    const scrolled = () => watch.on && Math.abs(scroller.scrollTop - watch.start) > 24;
    const onScroll = () => { if (scrolled()) cancelFx(); };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const check = () => {
      onScroll(); // scroll events only fire on painted frames, so also look at the position directly
      if (!alive || grabbed || scrolled()) throw ABORT;
    };
    const hold = async (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end) { check(); await nap(Math.min(80, end - performance.now())); }
      check();
    };
    const fx = (target: HTMLElement, frames: Keyframe[], ms: number, opts: KeyframeAnimationOptions = {}) => {
      const a = target.animate(frames, { duration: ms, composite: "add", ...opts });
      fxAnims.add(a);
      a.finished.catch(() => {}).finally(() => fxAnims.delete(a));
      return a;
    };

    // ---- Geometry. (rx, ry) is the dock's translate: x from its CSS left, y from the floor (negative is up).
    let W = 44, H = 64, base = 16;
    const measure = () => { W = el.offsetWidth || 44; H = el.offsetHeight || 64; base = parseFloat(getComputedStyle(el).left) || 0; };
    const vw = () => window.innerWidth, vh = () => window.innerHeight;
    const maxX = () => vw() - base - W - 8;
    /** Right end of the floor it strolls on: stops short of the chat launcher when there is room. */
    const fmax = () => {
      const l = document.querySelector(".cw-launch")?.getBoundingClientRect();
      return l && l.left - base - W - 14 > 240 ? l.left - base - W - 14 : maxX();
    };
    const txAt = (px: number) => clamp(px - base - W / 2, 0, maxX());
    const feetX = () => base + rx + W / 2;
    const feetY = () => vh() + ry;

    let rx = 0, ry = 0, rot = 0, scl = 1;
    const setPos = (x: number, y: number) => { rx = x; ry = y; el.style.translate = tr(x, y); };
    const setRot = (r: number) => { rot = r; el.style.rotate = `${r.toFixed(1)}deg`; };
    const setScl = (s: number) => { scl = s; el.style.scale = `${s}`; };
    const botAnims = new Set<Animation>();
    const anim = (frames: Keyframe[], ms: number, easing: string) => {
      const a = el.animate(frames, { duration: ms, easing, fill: "forwards" });
      botAnims.add(a);
      return a;
    };
    const done = (a: Animation) => a.finished.then(() => true, () => false).then((ok) => { botAnims.delete(a); return ok; });
    /** Stop every running flight where it is and keep that position. */
    const freeze = () => {
      const cs = getComputedStyle(el);
      const t = cs.translate === "none" ? [] : cs.translate.split(" ").map(parseFloat);
      const r = cs.rotate === "none" ? 0 : parseFloat(cs.rotate);
      const s = cs.scale === "none" ? 1 : parseFloat(cs.scale);
      setPos(t[0] || 0, t[1] || 0);
      setRot(r || 0);
      setScl(s || 1);
      botAnims.forEach((a) => a.cancel());
      botAnims.clear();
    };

    /** Fly through points [x, y, offset?] from where it is now. Never throws. */
    const glide = async (pts: Pt[], ms: number, easing = "ease-in-out") => {
      const frames: Keyframe[] = [{ translate: tr(rx, ry), offset: 0 }, ...pts.map(([px, py, o]) => (o == null ? { translate: tr(px, py) } : { translate: tr(px, py), offset: o }))];
      const a = anim(frames, ms, easing);
      if (await done(a)) { const l = pts[pts.length - 1]; setPos(l[0], l[1]); a.cancel(); }
    };
    const move = async (pts: Pt[], ms: number, easing?: string) => { await glide(pts, ms, easing); check(); };
    /** A jump: up fast, hang at the top, down fast. */
    const arc = async (tx: number, ty: number, h: number, ms: number) => {
      const a = anim([
        { translate: tr(rx, ry), easing: "cubic-bezier(0.2, 0.6, 0.4, 1)" },
        { translate: tr((rx + tx) / 2, Math.min(ry, ty) - h, ), easing: "cubic-bezier(0.6, 0, 0.8, 0.4)" },
        { translate: tr(tx, ty) },
      ], ms, "linear");
      if (await done(a)) { setPos(tx, ty); a.cancel(); }
      check();
    };
    const turn = async (to: number, ms: number, easing = "ease-in-out") => {
      const a = anim([{ rotate: `${rot}deg` }, { rotate: `${to}deg` }], ms, easing);
      if (await done(a)) { setRot(to); a.cancel(); }
    };
    const resize = async (to: number, ms: number) => {
      const a = anim([{ scale: `${scl}` }, { scale: `${to}` }], ms, "cubic-bezier(0.3, 1.5, 0.5, 1)");
      if (await done(a)) { setScl(to); a.cancel(); }
    };

    let facing = false;
    const face = (l: boolean) => { facing = l; setLeft(l); };
    const setVar = (k: string, v: number) => svg.style.setProperty(k, v.toFixed(2));
    const clearGait = () => { for (const k of ["--sw", "--bob", "--lean", "--roll"]) svg.style.removeProperty(k); };

    /**
     * Walk in a straight line to (tx, ty): speeds up, slows down before arriving, and the legs swing by the
     * ground actually covered, so the feet never slide. Works on the floor, on walls and on top of things.
     */
    const go = async (tx: number, ty: number, o: GoOpts = {}) => {
      const speed = o.speed ?? SPEED, fast = speed > 90;
      const x0 = rx, y0 = ry, total = Math.hypot(tx - x0, ty - y0);
      if (total < 2) return;
      const dir = tx >= x0 ? 1 : -1;
      face(o.face ?? (o.back ? dir > 0 : dir < 0));
      setPose(o.pose ?? (fast ? "run" : "walk"));
      const acc = speed * 3.2, stride = (fast ? 30 : 16) * scl;
      let v = 0, gone = 0, phase = 0, lean = 0, last = performance.now();
      try {
        while (gone < total - 0.5) {
          await frame();
          check();
          const now = performance.now(), dt = clamp((now - last) / 1000, 0.001, 0.25);
          last = now;
          const want = Math.min(speed, Math.sqrt(2 * acc * (total - gone)) + 8);
          const dv = clamp(want - v, -acc * 1.8 * dt, acc * dt);
          v += dv;
          const step = Math.min(total - gone, v * dt);
          gone += step;
          phase += (step / stride) * Math.PI;
          const k = gone / total, e = Math.min(1, 0.35 + v / speed);
          setPos(x0 + (tx - x0) * k, y0 + (ty - y0) * k);
          lean += ((fast ? 9 : 2.5) * (v / speed) + clamp(dv / (acc * dt), -1, 1) * (fast ? 8 : 3) - lean) * 0.18;
          setVar("--sw", Math.sin(phase) * (fast ? 27 : 17) * e);
          setVar("--bob", -Math.abs(Math.sin(phase)) * (fast ? 3.4 : 2.2) * e);
          setVar("--lean", lean);
          if (o.roll) setVar("--roll", dir * 360 * o.roll * k);
        }
      } finally {
        clearGait();
      }
    };
    const walkTo = (x: number, o: GoOpts = {}) => go(clamp(x, 0, maxX()), 0, o);
    const runTo = (x: number, o: GoOpts = {}) => walkTo(x, { speed: RUN, ...o });

    // ---- Small effects.
    const dust = (n = 3, x = feetX(), y = feetY()) => { for (let i = 0; i < n; i++) fleck(host, "rb-dust", x + rand(-8, 8), y - rand(1, 5), rand(-24, 24), -rand(6, 22)); };
    const quake = (p: number) => { if (page) fx(page, [0, -p, p * 0.7, -p * 0.4, p * 0.2, 0].map((v) => ({ transform: `translateY(${v}px)` })), 380); };
    /** Drop specks from under the bot until stopped. */
    const trail = (cls: string, every: number) => {
      const id = window.setInterval(() => {
        const r = el.getBoundingClientRect();
        fleck(host, cls, r.left + r.width / 2 + rand(-5, 5), r.bottom - 6, rand(-10, 10), rand(18, 34), 500);
      }, every);
      const stop = () => { window.clearInterval(id); undo.delete(stop); };
      undo.add(stop);
      return stop;
    };

    let bubble: HTMLElement | null = null, bubbleTimer = 0;
    const say = (text: string, ms = 1500) => {
      bubble?.remove();
      window.clearTimeout(bubbleTimer);
      const b = document.createElement("div");
      b.className = "rb-say";
      b.textContent = text;
      host.appendChild(b);
      bubble = b;
      bubbleTimer = window.setTimeout(() => { b.classList.add("out"); window.setTimeout(() => { b.remove(); if (bubble === b) bubble = null; }, 260); }, ms);
    };

    // ---- Always on: the eyes follow the cursor (or glance around on their own), the speech bubble follows the head.
    const mouse = { x: -1, y: -1, t: 0 };
    const onMouse = (e: PointerEvent) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.t = performance.now(); };
    window.addEventListener("pointermove", onMouse, { passive: true });
    let ex = 0, ey = 0, gx = 0, gy = 0, glanceAt = 0, near = false;
    const tick = () => {
      if (!alive) return;
      const now = performance.now(), r = el.getBoundingClientRect();
      const hx = r.left + r.width / 2, hy = r.top + r.height * 0.3;
      let tx = 0, ty = 0;
      const live = mouse.x >= 0 && now - mouse.t < 3500;
      if (live) {
        const dx = mouse.x - hx, dy = mouse.y - hy, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 140);
        tx = (dx / d) * 3.4 * k;
        ty = (dy / d) * 2.6 * k;
        near = d < 90 && now - mouse.t < 1500;
        const a = (-rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        [tx, ty] = [tx * c - ty * s, tx * s + ty * c];
      } else {
        near = false;
        if (now > glanceAt) { gx = coin(0.35) ? 0 : rand(-3, 3); gy = coin(0.35) ? 0 : rand(-1.2, 1.6); glanceAt = now + rand(700, 3000); }
        tx = gx;
        ty = gy;
      }
      if (facing) tx = -tx;
      ex += (tx - ex) * 0.16;
      ey += (ty - ey) * 0.16;
      setVar("--ex", ex);
      setVar("--ey", ey);
      if (bubble) {
        bubble.style.left = `${clamp(hx, 44, vw() - 44)}px`;
        bubble.style.top = `${Math.max(30, r.top - 4)}px`;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // ---- Being picked up and thrown.
    const drag = { down: false, px: 0, py: 0, ox: 0, oy: 0, moved: 0, t0: 0, samples: [] as [number, number, number][] };
    const onDown = (e: PointerEvent) => {
      if (e.button) return;
      e.preventDefault();
      try { hit.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      freeze();
      cancelFx();
      grabbed = true;
      Object.assign(drag, { down: true, px: e.clientX, py: e.clientY, ox: rx - e.clientX, oy: ry - e.clientY, moved: 0, t0: performance.now(), samples: [[e.clientX, e.clientY, performance.now()]] });
    };
    const onDrag = (e: PointerEvent) => {
      if (!drag.down) return;
      drag.moved += Math.hypot(e.clientX - drag.px, e.clientY - drag.py);
      drag.px = e.clientX;
      drag.py = e.clientY;
      drag.samples.push([e.clientX, e.clientY, performance.now()]);
      if (drag.samples.length > 6) drag.samples.shift();
    };
    const onUp = () => { drag.down = false; };
    hit.addEventListener("pointerdown", onDown);
    hit.addEventListener("pointermove", onDrag);
    hit.addEventListener("pointerup", onUp);
    hit.addEventListener("pointercancel", onUp);

    const dragged = async () => {
      el.classList.add("held");
      el.style.transformOrigin = "50% 22%"; // swings from the head while held
      setScl(1);
      let hard = false, poked = false;
      for (;;) {
        setPose("held");
        let ang = ((rot % 360) + 540) % 360 - 180, av = 0, lastX = rx;
        while (alive && drag.down) {
          await frame();
          const nx = drag.px + drag.ox, ny = Math.min(H * 0.3, drag.py + drag.oy);
          av = (av + (nx - lastX) * 0.9 - ang * 0.14) * 0.84;
          ang = clamp(ang + av, -80, 80);
          lastX = nx;
          setPos(nx, ny);
          setRot(ang);
        }
        if (!alive) return;
        const s = drag.samples, a0 = s[0], a1 = s[s.length - 1], sdt = Math.max(16, a1[2] - a0[2]) / 1000;
        let vx = clamp((a1[0] - a0[0]) / sdt, -2800, 2800), vy = clamp((a1[1] - a0[1]) / sdt, -2800, 2800);
        if (performance.now() - a1[2] > 120) vx = vy = 0;
        poked = drag.moved < 6 && performance.now() - drag.t0 < 400;
        if (Math.hypot(vx, vy) > 900) { hard = true; say(pick(SAY.thrown)); }
        let x = rx, y = ry, spin = vx * 0.35, last = performance.now();
        const lo = -base, hi = vw() - base - W, top = -(vh() - H);
        while (alive && !drag.down) {
          await frame();
          const now = performance.now(), dt = clamp((now - last) / 1000, 0.001, 0.05);
          last = now;
          vy += GRAVITY * dt;
          x += vx * dt;
          y += vy * dt;
          ang += spin * dt;
          if (x < lo) { x = lo; vx = Math.abs(vx) * 0.55; spin *= -0.5; }
          if (x > hi) { x = hi; vx = -Math.abs(vx) * 0.55; spin *= -0.5; }
          if (y < top) { y = top; vy = Math.abs(vy) * 0.4; }
          if (y >= 0) {
            y = 0;
            if (vy > 240) { vy *= -0.45; vx *= 0.72; spin = vx * 0.4; dust(3, base + x + W / 2, vh()); }
            else { vy = 0; vx *= 1 - Math.min(1, 9 * dt); spin *= 1 - Math.min(1, 9 * dt); if (Math.abs(vx) < 16) break; }
          }
          setPos(x, y);
          setRot(ang);
        }
        if (!alive) return;
        if (drag.down) continue;
        setPos(x, 0);
        setRot(ang);
        await turn(Math.round(rot / 360) * 360, 260, "cubic-bezier(0.3, 1.4, 0.5, 1)");
        if (!drag.down) break;
      }
      setRot(0);
      el.style.transformOrigin = "";
      el.classList.remove("held");
      setPos(clamp(rx, 0, maxX()), 0);
      grabbed = false;
      if (poked) {
        setPose("scared");
        say(pick(SAY.poke));
        await glide([[rx, -26, 0.5], [rx, 0]], 380);
        await nap(450);
      } else if (hard) {
        setPose("dizzy");
        await nap(1700);
      } else {
        setPose("land");
        await nap(350);
      }
    };

    /** Fall to the floor from wherever it is, upright again. Never throws. */
    const drop = async (dx = 0) => {
      const tx = clamp(rx + dx, 0, maxX());
      setPose("fall");
      const ms = clamp(Math.sqrt(Math.max(1, -ry)) * 34, 380, 1000);
      const tilted = Math.abs(rot % 360) > 0.5;
      await Promise.all([
        glide([[(rx + tx) / 2, ry - 18, 0.3], [tx, 0]], ms, "cubic-bezier(0.5, 0, 0.85, 0.6)"),
        tilted ? turn(Math.round(rot / 360) * 360, ms * 0.7) : null,
      ]);
      if (grabbed || !alive) return;
      setRot(0);
      setPose("land");
      dust(2);
      await nap(300);
    };

    /** After every act: tidy up whatever it left behind and get back onto the floor. */
    const recover = async () => {
      watch.on = false;
      cancelFx();
      [...undo].forEach((f) => f());
      undo.clear();
      clearGait();
      if (!alive) return;
      if (grabbed) return dragged();
      freeze();
      if (scl !== 1) await resize(1, 240);
      if (Math.abs(rot % 360) > 0.5 || Math.abs(ry) > 1) await drop();
      else { setRot(0); setPos(clamp(rx, 0, maxX()), 0); }
    };

    const leap = async (y: number, flip = false, crouch = true) => {
      if (crouch) { setPose("crouch"); await hold(240); }
      setPose(flip ? "flip" : "hang");
      const ms = clamp(440 + Math.sqrt(Math.max(1, -y)) * 14, 480, 900);
      await move([[rx, y - 46, 0.62], [rx, y]], ms, "cubic-bezier(0.25, 0.7, 0.4, 1)");
    };

    const approach = async (target: HTMLElement, px: (r: DOMRect) => number) => {
      await runTo(txAt(px(boxOf(target))));
      return boxOf(target);
    };

    // ---- Finding things to play with.
    const candidates = (kind: "top" | "bottom") => {
      const h = vh();
      return [...document.querySelectorAll<HTMLElement>(TARGETS)].filter((t) => {
        const r = boxOf(t);
        if (r.width < 44 || r.height < 18 || r.left < 0 || r.right > vw() - 4) return false;
        return kind === "top" ? r.top > 130 && r.top < h - 110 : r.bottom > 150 && r.bottom < h - H - 36 && r.height < 460;
      });
    };
    const standY = (r: DOMRect) => r.top - vh();
    const hangY = (r: DOMRect) => r.bottom - 2 - (vh() - H);
    const steps = [0, 0.4, 0.55, 0.7, 0.85, 1];
    const tugs = [0, 1, 0.72, 1.06, 0.86, 1];

    let gearNow: Gear = "none";
    const A: Record<string, Act> = {};

    // ================= On the floor =================
    A.walk = { w: 4, run: async () => {
      const max = fmax();
      let to = rand(0, max);
      if (Math.abs(to - rx) < 60) to = clamp(rx + (rx > max / 2 ? -1 : 1) * rand(90, 220), 0, max);
      await walkTo(to);
    } };
    A.run = { w: 2, run: async () => {
      const max = fmax();
      const to = rx > max / 2 ? rand(0, max * 0.3) : rand(max * 0.6, max);
      await runTo(to, { speed: RUN * rand(1, 1.5) });
      if (coin(0.5)) { setPose("skid"); dust(4); await hold(420); }
    } };
    for (const [name, w, ms] of [["idle", 1, 1400], ["look", 1, 2200], ["wave", 0.8, 1800], ["hop", 0.9, 1300], ["head", 0.8, 3400], ["nap", 0.5, 4200], ["dance", 1, 2600], ["yawn", 0.8, 1700], ["juggle", 1.2, 3400]] as [string, number, number][]) {
      A[name] = { w, run: async () => { setPose(name === "yawn" ? "stretch" : name); await hold(ms); } };
    }
    A.laugh = { w: 0.7, run: async () => { setPose("laugh"); say("haha"); await hold(1500); } };
    A.sing = { w: 0.7, run: async () => { setPose("dance"); say(pick(SAY.song), 2200); await hold(2400); } };
    A.notice = { w: 40, ok: () => near && ry === 0, run: async () => {
      face(mouse.x < feetX());
      setPose(coin(0.3) ? "scared" : "wave");
      say(pick(SAY.hi));
      await hold(1600);
    } };
    A.edgesit = { w: 1, run: async () => {
      setPose("edgesit");
      await move([[rx, W * (15 / 72)]], 320, "ease-out");
      await hold(rand(2600, 4000));
      setPose("hang");
      await move([[rx, -12, 0.6], [rx, 0]], 420);
      setPose("land");
      await hold(300);
    } };
    A.flip = { w: 0.9, run: async () => {
      setPose("crouch");
      await hold(220);
      setPose("flip");
      await arc(rx, 0, 52, 760);
      setPose("land");
      dust(2);
      await hold(320);
    } };
    A.trip = { w: 0.7, run: async () => {
      await runTo(clamp(rx + (coin() ? -1 : 1) * rand(70, 140), 0, fmax()));
      setPose("trip");
      say(pick(SAY.oops), 1100);
      await hold(2400);
    } };
    A.moonwalk = { w: 1.1, run: async () => {
      const max = fmax(), d = rx > max / 2 ? -1 : 1;
      say(pick(SAY.song));
      await walkTo(clamp(rx + d * rand(140, 260), 0, max), { speed: 40, back: true, pose: "moon" });
      setPose("cheer");
      await hold(600);
    } };
    A.sneak = { w: 0.9, run: async () => {
      const max = fmax(), d = rx > max / 2 ? -1 : 1;
      await walkTo(clamp(rx + d * rand(70, 130), 0, max), { speed: 22, pose: "sneak" });
      setPose("look");
      await hold(1400);
      await walkTo(clamp(rx + d * rand(50, 90), 0, max), { speed: 22, pose: "sneak" });
    } };
    A.cartwheel = { w: 1.1, run: async () => {
      const lap = Math.PI * H * 0.9, max = fmax();
      const n = coin(0.4) ? 2 : 1, d = rx + lap * n < max ? (rx - lap * n > 0 && coin() ? -1 : 1) : -1;
      if (rx + d * lap * n < 0 || rx + d * lap * n > maxX()) return A.flip.run(el);
      await go(rx + d * lap * n, 0, { speed: 190, pose: "roll", roll: n });
      setPose("cheer");
      await hold(700);
    } };
    A.dive = { w: 0.9, run: async () => {
      const max = fmax(), d = rx > max / 2 ? -1 : 1;
      await runTo(clamp(rx + d * rand(120, 200), 0, max), { speed: RUN * 1.3 });
      setPose("dive");
      say(pick(SAY.fly), 900);
      const stop = trail("rb-dust", 70);
      await move([[clamp(rx + d * 130, 0, maxX()), 0]], 800, "cubic-bezier(0.1, 0.7, 0.3, 1)");
      stop();
      await hold(600);
      setPose("land");
      await hold(300);
    } };
    A.twirl = { w: 0.8, run: async () => {
      setPose("twirl");
      await hold(1500);
      setPose("dizzy");
      await hold(1700);
    } };
    A.pogo = { w: 1, run: async () => {
      const max = fmax(), d = rx > max / 2 ? -1 : 1;
      face(d < 0);
      for (let i = 0; i < 5; i++) {
        setPose(i === 4 ? "flip" : "hang");
        await arc(clamp(rx + d * rand(46, 70), 0, max), 0, 30 + i * 12, i === 4 ? 760 : 400 + i * 20);
        setPose("land");
        dust(2);
        await hold(110);
      }
      await hold(300);
    } };
    A.sneeze = { w: 0.7, run: async () => {
      setPose("sneeze");
      await hold(700);
      const d = facing ? -1 : 1;
      for (let i = 0; i < 6; i++) fleck(host, "rb-dust", feetX() + d * 14, feetY() - H * 0.62, d * rand(20, 60), rand(-16, 16));
      say("achoo!", 1100);
      await move([[clamp(rx - d * 36, 0, maxX()), 0]], 280, "ease-out");
      await hold(900);
    } };
    A.wrap = { w: 0.8, run: async () => {
      const goLeft = rx < maxX() / 2;
      await go(goLeft ? -base - W - 30 : vw() - base + 30, 0, { speed: RUN * 1.3 });
      await hold(800);
      setPos(goLeft ? vw() - base + 30 : -base - W - 30, 0);
      const max = fmax();
      await go(goLeft ? rand(max * 0.55, max) : rand(0, max * 0.4), 0, { speed: RUN * 1.3 });
      setPose("wave");
      await hold(900);
    } };
    A.dig = { w: 1, run: async () => {
      setPose("crouch");
      await hold(220);
      const max = fmax();
      for (let i = 0, n = coin(0.5) ? 2 : 1; i < n; i++) {
        dust(5);
        await move([[rx, H + 12]], 420, "ease-in");
        await hold(450);
        setPos(clamp(rx + (coin() ? -1 : 1) * rand(140, 420), 0, max), H + 12);
        setPose("look");
        await move([[rx, H * 0.6]], 380, "ease-out");
        await hold(1300);
      }
      setPose("hang");
      dust(4);
      await arc(rx, 0, H * 0.6 + 34, 520);
      setPose("land");
      say("boo!", 1000);
      await hold(500);
    } };
    A.gear = { w: 1.4, run: async () => {
      setPose("crouch");
      await hold(260);
      burst(host, feetX(), feetY() - H * 0.8);
      gearNow = pick(GEARS.filter((g) => g !== gearNow));
      setGear(gearNow);
      setPose("cheer");
      if (gearNow !== "none") say(pick(SAY.look));
      await hold(1100);
    } };
    A.giant = { w: 0.9, run: async () => {
      burst(host, feetX(), feetY() - H / 2);
      setPose("cheer");
      await resize(2.3, 520);
      check();
      const d = rx > fmax() / 2 ? -1 : 1;
      face(d < 0);
      for (let i = 0; i < 4; i++) {
        setPose("fall");
        await arc(clamp(rx + d * 54, 0, maxX() - W), 0, 40, 460);
        setPose("land");
        quake(7);
        dust(6);
        await hold(260);
      }
      setPose("laugh");
      say("hehe");
      await hold(900);
      burst(host, feetX(), feetY() - H);
      await resize(1, 380);
    } };
    A.tiny = { w: 0.8, run: async () => {
      burst(host, feetX(), feetY() - H / 2);
      await resize(0.45, 320);
      check();
      const max = fmax();
      for (let i = 0; i < 3; i++) await walkTo(rx > max / 2 ? rand(0, max * 0.35) : rand(max * 0.65, max), { speed: RUN * 1.7 });
      setPose("scared");
      await hold(350);
      burst(host, feetX(), feetY() - H / 4);
      await resize(1, 380);
    } };
    A.shove = { w: 0.9, ok: () => !!page, run: async () => {
      const right = rx > maxX() / 2, d = right ? 1 : -1;
      await runTo(right ? maxX() : 0);
      face(!right);
      setPose("push");
      for (let i = 0; i < 3; i++) {
        const p = (i === 2 ? 30 : 9 + i * 4) * d;
        if (i === 1) say(pick(SAY.strain), 1000);
        fx(page!, [{ transform: ID }, { offset: 0.5, transform: `translateX(${p}px) skewX(${(-p / 22).toFixed(2)}deg)` }, { offset: 0.75, transform: `translateX(${(-p * 0.3).toFixed(1)}px)` }, { transform: ID }], i === 2 ? 900 : 620, { easing: "ease-out" });
        await hold(i === 2 ? 520 : 680);
      }
      setPose("trip");
      await move([[clamp(rx - d * 80, 0, maxX()), 0]], 420, "ease-out");
      await hold(2000);
    } };
    A.ball = { w: 1.3, run: async () => {
      const b = document.createElement("i");
      b.className = "rb-ball";
      host.appendChild(b);
      const s = { x: feetX() + (rx > fmax() / 2 ? -1 : 1) * W * 0.7, y: vh(), vx: 0, vy: 0, a: 0, live: true };
      const put = () => { b.style.translate = tr(s.x, s.y); b.style.rotate = `${s.a.toFixed(0)}deg`; };
      const kill = () => { s.live = false; undo.delete(kill); b.classList.add("out"); window.setTimeout(() => b.remove(), 400); };
      undo.add(kill);
      put();
      (async () => {
        let last = performance.now();
        while (s.live && alive) {
          await frame();
          const now = performance.now(), dt = clamp((now - last) / 1000, 0.001, 0.05);
          last = now;
          s.vy += 1700 * dt;
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          s.a += s.vx * dt * 3;
          if (s.y >= vh()) { s.y = vh(); s.vy = s.vy > 90 ? -s.vy * 0.62 : 0; s.vx *= 1 - Math.min(1, 1.4 * dt); }
          if (s.x < 9) { s.x = 9; s.vx = Math.abs(s.vx) * 0.7; }
          if (s.x > vw() - 9) { s.x = vw() - 9; s.vx = -Math.abs(s.vx) * 0.7; }
          put();
        }
      })();
      await hold(450);
      for (let i = 0; i < 3; i++) {
        const d = s.x < vw() / 2 ? 1 : -1;
        await runTo(txAt(s.x - d * W * 0.7), { speed: RUN * 1.25 });
        if (Math.abs(s.x - feetX()) > 110) await runTo(txAt(s.x - d * W * 0.7), { speed: RUN * 1.4 });
        face(d < 0);
        setPose("kick");
        await hold(130);
        if (Math.abs(s.x - feetX()) < 130) { s.vx = d * rand(380, 660); s.vy = -rand(420, 700); dust(2); }
        await hold(520);
        setPose("look");
        await hold(500);
      }
      setPose("cheer");
      say(pick(SAY.yay));
      await hold(900);
      kill();
    } };
    A.plane = { w: 1.1, run: async () => {
      const d = feetX() < vw() / 2 ? 1 : -1;
      face(d < 0);
      setPose("throw");
      await hold(280);
      const p = document.createElement("div");
      p.className = "rb-plane";
      p.innerHTML = '<svg viewBox="0 0 30 30"><path d="M3 14 L27 4 L18 26 L14 17 Z M14 17 L27 4"/></svg>';
      if (d < 0) p.style.scale = "1 -1";
      host.appendChild(p);
      const x0 = feetX() + d * 12, y0 = feetY() - H * 0.8, w = vw(), h = vh();
      const pts = [[x0, y0], [x0 + d * w * 0.18, y0 - h * 0.3], [x0 + d * w * 0.34, y0 - h * 0.12], [x0 + d * w * 0.5, y0 - h * 0.45], [x0 + d * w * 0.66, y0 - h * 0.26], [d > 0 ? w + 80 : -80, y0 - h * 0.55]];
      const frames = pts.map((q, i) => {
        const n = pts[Math.min(i + 1, pts.length - 1)], m = pts[Math.max(i - 1, 0)];
        const ang = (Math.atan2(n[1] - m[1], n[0] - m[0]) * 180) / Math.PI;
        return { translate: tr(q[0], q[1]), rotate: `${(ang + 22 * d).toFixed(0)}deg` };
      });
      p.animate(frames, { duration: 2800, easing: "cubic-bezier(0.3, 0, 0.7, 0.6)" }).finished.catch(() => {}).finally(() => p.remove());
      setPose("look");
      await hold(1000);
      setPose("wave");
      say(pick(SAY.fly));
      await hold(1500);
    } };
    A.balloon = { w: 1.2, run: async () => {
      setPose("float");
      const h = vh() * rand(0.4, 0.72), max = maxX();
      const x1 = clamp(rx + rand(-1, 1) * vw() * 0.25, 0, max), x2 = clamp(x1 + rand(-1, 1) * vw() * 0.3, 0, max);
      face(x1 < rx);
      await move([[(rx + x1) / 2 + 20, -h * 0.5, 0.5], [x1, -h]], 3000);
      face(x2 < rx);
      await move([[(rx + x2) / 2, -h - 36, 0.5], [x2, -h + 10]], 2600);
      burst(host, feetX() + (facing ? -18 : 18), feetY() - H * 1.6);
      setPose("scared");
      await hold(420);
      if (coin(0.55)) {
        setPose("glide");
        await move([[rx + 40, ry * 0.66, 0.33], [rx - 40, ry * 0.33, 0.66], [clamp(rx + rand(-60, 60), 0, max), 0]], 3200, "linear");
        setPose("land");
        await hold(300);
      } else {
        await drop();
        check();
        setPose("dizzy");
        await hold(1500);
      }
    } };
    A.jetpack = { w: 1.3, run: async () => {
      setPose("crouch");
      await hold(260);
      setPose("jet");
      say(pick(SAY.fly), 900);
      const stop = trail("rb-fire", 45);
      const max = maxX(), top = -(vh() - H - 70);
      for (let i = 0, n = 3 + Math.floor(rand(0, 3)); i < n; i++) {
        const x = rx < max / 2 ? rand(max * 0.45, max) : rand(0, max * 0.55), y = rand(top, -90);
        face(x < rx);
        const ms = clamp(Math.hypot(x - rx, y - ry) * 2.4, 700, 1700);
        const loop = coin(0.3);
        await Promise.all([move([[x, y]], ms, "cubic-bezier(0.45, 0, 0.3, 1)"), loop ? turn(rot + (x < rx ? -360 : 360), ms) : turn((x < rx ? -1 : 1) * 16, 300)]);
        setRot(((rot % 360) + 540) % 360 - 180);
      }
      await Promise.all([move([[rx, 0]], clamp(-ry * 2.2, 500, 1400), "cubic-bezier(0.3, 0, 0.4, 1)"), turn(0, 300)]);
      stop();
      setPose("land");
      dust(5);
      await hold(350);
      setPose("cheer");
      await hold(700);
    } };
    A.wall = { w: 1.4, run: async () => {
      const leftSide = rx < maxX() / 2, sgn = leftSide ? 1 : -1;
      const wx = leftSide ? -base - W / 2 + 2 : vw() - base - W / 2 - 2;
      await runTo(leftSide ? 0 : maxX());
      setPose("crouch");
      await hold(200);
      setPose("hang");
      await Promise.all([move([[wx, -56]], 320, "ease-out"), turn(sgn * 90, 320)]);
      const ceil = coin(0.5), up = ceil ? vh() - H * 0.9 : vh() * rand(0.4, 0.75);
      await go(wx, -up, { speed: 120, face: leftSide });
      if (!ceil) {
        setPose("wave");
        say(pick(SAY.hi));
        await hold(1400);
        setPose("flip");
        const x = clamp(leftSide ? rand(120, 320) : maxX() - rand(120, 320), 0, maxX());
        await Promise.all([arc(x, 0, 50, 900), turn(0, 600)]);
        setPose("land");
        dust(4);
        await hold(400);
        return;
      }
      const cx = wx + sgn * H * 0.7;
      await Promise.all([move([[cx, -vh() + 2]], 300), turn(sgn * 180, 300)]);
      await go(cx + sgn * rand(160, Math.min(520, vw() * 0.4)), ry, { speed: 80, face: leftSide });
      setPose("look");
      say(pick(SAY.hmm), 900);
      await hold(1000);
      setPose("scared");
      await hold(350);
      if (coin(0.5)) {
        setPose("glide");
        await turn(sgn * 360, 320);
        setRot(0);
        await move([[rx + 36, ry * 0.66, 0.33], [rx - 36, ry * 0.33, 0.66], [clamp(rx, 0, maxX()), 0]], 3000, "linear");
        setPose("land");
        await hold(300);
      } else {
        await drop();
        check();
        setPose("dizzy");
        await hold(1500);
      }
    } };
    A.chase = { w: 1.6, ok: () => mouse.x > 0 && performance.now() - mouse.t < 6000 && mouse.y < vh() - 90, run: async () => {
      say("!", 700);
      setPose("scared");
      await hold(350);
      for (let i = 0; i < 3; i++) {
        await runTo(txAt(mouse.x), { speed: RUN * 1.3 });
        const want = mouse.y - vh() + H * 0.75, reach = Math.abs(mouse.x - feetX()) < 40 && want > -360;
        setPose("crouch");
        await hold(180);
        setPose("hang");
        if (reach) {
          await move([[rx, want]], 380, "cubic-bezier(0.2, 0.7, 0.4, 1)");
          burst(host, feetX(), feetY() - H);
          say("gotcha!");
          await drop();
          check();
          setPose("cheer");
          await hold(1000);
          return;
        }
        await arc(rx, 0, Math.min(300, -want * 0.7), 700);
        setPose("land");
        await hold(250);
      }
      setPose("look");
      say(pick(SAY.hmm));
      await hold(1100);
    } };
    A.theme = { w: 0.7, ok: () => {
      const r = document.querySelector(".lp-theme")?.getBoundingClientRect();
      return !!r && r.width > 0 && r.top >= 0 && r.bottom < vh() - 220;
    }, run: async () => {
      const btn = document.querySelector<HTMLElement>(".lp-theme");
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      await runTo(txAt(r.left + r.width / 2));
      setPose("charge");
      await hold(650);
      await leap(r.top - vh(), true, false);
      setPose("land");
      burst(host, feetX(), r.top);
      btn.click();
      const back = () => { undo.delete(back); btn.click(); };
      undo.add(back); // the switch is always put back, even if the act is cut short
      await hold(500);
      setPose("scared");
      say(pick(SAY.oops));
      await hold(1500);
      setPose("hang");
      await arc(rx, ry, 26, 420);
      burst(host, feetX(), r.top);
      back();
      setPose("cheer");
      say("fixed!");
      await hold(900);
    } };

    // ================= On top of a page element =================
    A.stomp = { w: 3, kind: "top", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.25, 0.75));
      const big = coin(0.55);
      if (big) { setPose("charge"); await hold(650); }
      await leap(standY(r), big, !big);
      setPose("land");
      burst(host, feetX(), r.top);
      const h = t.getBoundingClientRect().height, k = 1 - Math.min(0.12, 14 / h);
      fx(t, [{ transform: ID }, { offset: 0.25, transform: squash(k, h) }, { offset: 0.55, transform: squash(1 + (1 - k) * 0.35, h) }, { transform: ID }], 560, { easing: "ease-out" });
      if (t.hasAttribute("data-bot-stomp")) t.click();
      await hold(340);
      setPose("cheer");
      await hold(1200);
    } };
    A.sit = { w: 2.2, kind: "top", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.2, 0.8));
      await leap(r.top + W * (15 / 72) - vh());
      setPose("sit");
      const h = t.getBoundingClientRect().height, k = 1 - Math.min(0.05, 6 / h);
      const press = fx(t, [{ transform: ID }, { transform: squash(k, h) }], 300, { fill: "forwards", easing: "ease-out" });
      await hold(rand(2200, 3400));
      if (t.matches("[data-bot-perch]")) {
        setPose("tap");
        await hold(300);
        document.querySelector<HTMLElement>("[data-bot-perch-next]")?.click();
        await hold(200);
      }
      fx(t, [{ transform: squash(k, h) }, { offset: 0.5, transform: squash(1 + (1 - k), h) }, { transform: ID }], 420);
      press.cancel();
    } };
    A.shake = { w: 2, kind: "top", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.25, 0.75));
      const y = standY(r);
      await leap(y);
      setPose("cheer");
      const h = t.getBoundingClientRect().height;
      for (let i = 0; i < 4; i++) {
        const hop = move([[rx, y - rand(14, 24), 0.45], [rx, y]], 380);
        window.setTimeout(() => { if (!scrolled() && !grabbed) fx(t, [{ transform: ID }, { offset: 0.3, transform: `${squash(0.95, h)} rotate(${i % 2 ? 1.6 : -1.6}deg)` }, { transform: ID }], 380, { easing: "ease-out" }); }, 330);
        await hop;
      }
      await hold(500);
    } };
    A.tilt = { w: 1.6, kind: "top", fit: (r) => r.width >= 160, run: async (t) => {
      const r0 = boxOf(t);
      const right = coin();
      const r = await approach(t, (b) => b.left + b.width * (right ? rand(0.72, 0.86) : rand(0.14, 0.28)));
      const y = standY(r);
      await leap(y);
      setPose("land");
      await hold(260);
      const cx = r.left + r.width / 2;
      const th = (right ? 1 : -1) * clamp(600 / Math.max(r0.width, 1), 1.5, 4);
      const tan = Math.tan((th * Math.PI) / 180);
      setPose("hang");
      const tip = fx(t, [{ transform: ID }, { transform: `rotate(${th}deg)` }], 500, { fill: "forwards", easing: "cubic-bezier(0.3, 1.4, 0.5, 1)" });
      await move([[rx, y + (feetX() - cx) * tan]], 500, "ease-out");
      const e = txAt(right ? r.right - W * 0.15 : r.left + W * 0.15);
      await move([[e, y + (base + e + W / 2 - cx) * tan]], 700, "ease-in");
      fx(t, [{ transform: `rotate(${th}deg)` }, { offset: 0.4, transform: `rotate(${-th * 0.4}deg)` }, { offset: 0.7, transform: `rotate(${th * 0.15}deg)` }, { transform: ID }], 800);
      tip.cancel();
      await drop(right ? 28 : -28);
    } };
    A.sticker = { w: 2.2, kind: "top", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.2, 0.8));
      await leap(standY(r));
      setPose("land");
      await hold(200);
      for (let i = 0, n = coin(0.3) ? 3 : 1; i < n; i++) {
        setPose("place");
        await hold(360);
        const now = t.getBoundingClientRect();
        stick(host, t, feetX() + (coin() ? -1 : 1) * rand(18, 46), now.top + Math.min(now.height * 0.55, rand(12, 40)));
        await hold(300);
      }
      setPose("wave");
      await hold(1100);
    } };
    A.trampoline = { w: 2.4, kind: "top", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.35, 0.65));
      const y = standY(r);
      await leap(y);
      const h = t.getBoundingClientRect().height;
      for (let i = 0; i < 4; i++) {
        const k = 1 - Math.min(0.1, (8 + i * 3) / h);
        fx(t, [{ transform: ID }, { offset: 0.3, transform: squash(k, h) }, { offset: 0.65, transform: squash(1 + (1 - k) * 0.4, h) }, { transform: ID }], 420, { easing: "ease-out" });
        setPose(i === 3 ? "flip" : i % 2 ? "cheer" : "hang");
        await arc(rx, y, 34 + i * 34, i === 3 ? 800 : 480 + i * 80);
      }
      setPose("land");
      burst(host, feetX(), r.top);
      say(pick(SAY.yay));
      await hold(900);
    } };
    A.tightrope = { w: 2, kind: "top", fit: (r) => r.width >= 190, run: async (t) => {
      const fromLeft = coin();
      const r = await approach(t, (b) => (fromLeft ? b.left + 14 : b.right - 14));
      const y = standY(r), a = txAt(r.left + 14), b = txAt(r.right - 14);
      await leap(y);
      const to = fromLeft ? b : a, mid = (a + b) / 2 + rand(-20, 20);
      await go(mid, y, { speed: 30, pose: "balance" });
      setPose("wobble");
      say(pick(SAY.oops), 900);
      await hold(1100);
      await go(to, y, { speed: 34, pose: "balance" });
      setPose("cheer");
      await hold(900);
    } };
    A.flipit = { w: 2, kind: "top", fit: (r) => r.width < 620, run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.35, 0.65));
      const y = standY(r);
      await leap(y);
      setPose("crouch");
      await hold(240);
      setPose("flip");
      const small = r.width < 240;
      fx(t, [{ transform: small ? "rotate(0deg)" : "rotateX(0deg)" }, { transform: small ? "rotate(360deg)" : "rotateX(360deg)" }], 720, { easing: "cubic-bezier(0.4, 0, 0.3, 1)" });
      await arc(rx, y, 64, 800);
      setPose("land");
      burst(host, feetX(), r.top);
      await hold(300);
      setPose("cheer");
      await hold(800);
    } };
    A.paint = { w: 2, kind: "top", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.25, 0.75));
      await leap(standY(r));
      setPose("land");
      await hold(220);
      setPose("place");
      await hold(380);
      const f = pick(PAINTS);
      const a = t.animate([{ filter: "none" }, { offset: 0.12, filter: f }, { offset: 0.85, filter: f }, { filter: "none" }], { duration: 3200, easing: "ease-in-out" });
      fxAnims.add(a);
      a.finished.catch(() => {}).finally(() => fxAnims.delete(a));
      burst(host, feetX(), r.top + 6);
      await hold(400);
      setPose("cheer");
      say(pick(SAY.yay));
      await hold(1500);
      setPose("look");
      await hold(1000);
    } };

    // ================= Hanging under a page element =================
    A.stretch = { w: 3, kind: "bottom", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.3, 0.7));
      const y = hangY(r);
      await leap(y);
      const h = t.getBoundingClientRect().height, s = Math.min(0.5, 38 / h);
      const pull = fx(t, tugs.map((k, i) => ({ offset: steps[i], transform: stretchDown(1 + k * s, h) })), 2000, { fill: "forwards", easing: "ease-in-out" });
      await move(tugs.slice(1).map((k, i) => [rx, y + h * s * k, steps[i + 1]] as Pt), 2000);
      fx(t, [{ transform: stretchDown(1 + s, h) }, { offset: 0.3, transform: "scale(1.02, 0.9)" }, { offset: 0.55, transform: "scale(0.99, 1.05)" }, { offset: 0.78, transform: "scale(1.005, 0.98)" }, { transform: ID }], 900, { easing: "ease-out" });
      pull.cancel();
    } };
    A.skew = { w: 1.8, kind: "bottom", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.35, 0.65));
      await leap(hangY(r));
      setPose("swing");
      fx(t, [{ transform: ID }, { offset: 0.2, transform: "skewX(8deg)" }, { offset: 0.4, transform: "skewX(-7deg)" }, { offset: 0.6, transform: "skewX(5deg)" }, { offset: 0.8, transform: "skewX(-3deg)" }, { transform: ID }], 2000, { easing: "ease-in-out" });
      await hold(2000);
    } };
    A.squeeze = { w: 1.8, kind: "bottom", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * 0.5);
      await leap(hangY(r));
      setPose("hang");
      const g = fx(t, [{ transform: ID }, { offset: 0.35, transform: "scale(0.9, 1.05)" }, { offset: 0.55, transform: "scale(0.94, 1.03)" }, { offset: 0.75, transform: "scale(0.88, 1.06)" }, { transform: "scale(0.9, 1.05)" }], 1600, { fill: "forwards", easing: "ease-in-out" });
      await hold(1600);
      fx(t, [{ transform: "scale(0.9, 1.05)" }, { offset: 0.35, transform: "scale(1.05, 0.96)" }, { offset: 0.65, transform: "scale(0.98, 1.02)" }, { transform: ID }], 700, { easing: "ease-out" });
      g.cancel();
    } };
    A.pullright = { w: 2, kind: "bottom", fit: (r) => r.right < vw() - 130 && r.width <= 720, run: async (t) => {
      const r = await approach(t, (b) => b.right - 6);
      const y = hangY(r);
      await leap(y);
      setPose("pull");
      const w = t.getBoundingClientRect().width, s = Math.min(0.3, 80 / w);
      const pull = fx(t, tugs.map((k, i) => ({ offset: steps[i], transform: stretchRight(1 + k * s, w) })), 1800, { fill: "forwards", easing: "ease-in-out" });
      const x0 = rx;
      await move(tugs.slice(1).map((k, i) => [x0 + w * s * k, y, steps[i + 1]] as Pt), 1800);
      fx(t, [{ transform: stretchRight(1 + s, w) }, { offset: 0.3, transform: stretchRight(1 - s * 0.25, w) }, { offset: 0.6, transform: stretchRight(1 + s * 0.08, w) }, { transform: ID }], 800, { easing: "ease-out" });
      pull.cancel();
      await drop(34);
    } };
    A.monkeybars = { w: 2.2, kind: "bottom", fit: (r) => r.width >= 170, run: async (t) => {
      const fromLeft = coin();
      const r = await approach(t, (b) => (fromLeft ? b.left + 16 : b.right - 16));
      const y = hangY(r), end = txAt(fromLeft ? r.right - 16 : r.left + 16);
      await leap(y);
      const n = clamp(Math.round(Math.abs(end - rx) / 46), 3, 9), step = (end - rx) / n;
      face(step < 0);
      setPose("swing");
      for (let i = 0; i < n; i++) {
        fx(t, [{ transform: ID }, { offset: 0.5, transform: `skewX(${i % 2 ? 1.2 : -1.2}deg) translateY(1.5px)` }, { transform: ID }], 340);
        await move([[rx + step / 2, y + 7, 0.5], [rx + step, y]], 340);
      }
      setPose("hang");
      await hold(500);
    } };
    A.pullups = { w: 1.8, kind: "bottom", run: async (t) => {
      const r = await approach(t, (b) => b.left + b.width * rand(0.3, 0.7));
      const y = hangY(r);
      await leap(y);
      setPose("hang");
      await move([[rx, y + 12]], 300);
      for (let i = 1; i <= 3; i++) {
        fx(t, [{ transform: ID }, { offset: 0.5, transform: "translateY(3px)" }, { transform: ID }], 700, { easing: "ease-in-out" });
        await move([[rx, y - 4]], 420 + i * 80, "ease-out");
        say(`${i}`, 500);
        await move([[rx, y + 12]], 320, "ease-in");
      }
      say("phew", 900);
      await hold(700);
    } };

    // ---- Choosing what to do next: the less an act has been seen (ever, and lately), the likelier it is.
    let seen: Record<string, number> = {};
    try { seen = JSON.parse(window.localStorage.getItem(SEEN_KEY) || "{}") || {}; } catch { /* storage blocked */ }
    const recent: string[] = [];
    let forced: string | null = null;
    let lastTarget: HTMLElement | null = null;
    const hopbot = (name?: string) => { if (name && A[name]) forced = name; return Object.keys(A); };
    (window as unknown as { hopbot?: typeof hopbot }).hopbot = hopbot;

    const next = async () => {
      check();
      const lists = { top: candidates("top"), bottom: candidates("bottom") };
      const opts: [string, number, HTMLElement[]][] = [];
      for (const [name, a] of Object.entries(A)) {
        const list = a.kind ? lists[a.kind].filter((t) => !a.fit || a.fit(boxOf(t))) : [];
        if ((a.kind && !list.length) || (a.ok && !a.ok())) continue;
        const i = recent.indexOf(name);
        let w = (a.kind ? a.w * 1.5 : a.w) / (1 + (seen[name] ?? 0) * 0.8);
        if (i >= 0) w *= i < 6 ? 0.03 : 0.3;
        if (name === forced) w = 1e9;
        opts.push([name, w, list]);
      }
      forced = null;
      let roll = Math.random() * opts.reduce((s, o) => s + o[1], 0);
      const [name, , list] = opts.find((o) => (roll -= o[1]) <= 0) ?? opts[0];
      recent.unshift(name);
      recent.length = Math.min(recent.length, 14);
      seen[name] = (seen[name] ?? 0) + 1;
      try { window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* storage blocked */ }
      let t: HTMLElement = el;
      if (list.length) {
        t = pick(list);
        if (t === lastTarget && list.length > 1) t = list.find((c) => c !== lastTarget) ?? t;
        lastTarget = t;
        watch.start = scroller.scrollTop;
        watch.on = true;
      }
      await A[name].run(t);
    };

    const run = async () => {
      await nap(900);
      let first = true;
      while (alive) {
        measure();
        try {
          if (first) { first = false; setPose("wave"); say(pick(SAY.hi)); await hold(1800); }
          else await next();
        } catch (e) {
          if (e !== ABORT) console.error(e);
        }
        await recover();
        if (alive && !grabbed) { setPose("idle"); await nap(rand(150, 800)); }
      }
    };
    run();

    return () => {
      alive = false;
      timers.forEach((t) => window.clearTimeout(t));
      window.clearTimeout(bubbleTimer);
      bubble?.remove();
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", onMouse);
      hit.removeEventListener("pointerdown", onDown);
      hit.removeEventListener("pointermove", onDrag);
      hit.removeEventListener("pointerup", onUp);
      hit.removeEventListener("pointercancel", onUp);
      cancelFx();
      [...undo].forEach((f) => f());
      botAnims.forEach((a) => a.cancel());
      delete (window as unknown as { hopbot?: unknown }).hopbot;
    };
  }, []);

  return (
    <div ref={dock} className="rb-dock" aria-hidden>
      <svg ref={art} className={`la rb is-${pose}${left ? " face-left" : ""}`} viewBox="24 22 72 104" fill="none">
        <g className="la-boil">
          <ellipse className="rb-shadow" cx="60" cy="123" rx="22" ry="3" />
          <path className="i rb-z" d="M88 30 h8 l-8 9 h8" />
          <g className="rb-all">
            <g className="rb-prop rb-jet">
              <path className="i rb-fire" d="M27 99 q5 14 5 20 q0 -6 5 -20" />
              <rect className="i b bg" x="25" y="70" width="14" height="30" rx="6" />
            </g>
            <g className="rb-prop rb-brolly">
              <path className="i b rb-fill" d="M16 18 Q60 -34 104 18 Q82 8 60 18 Q38 8 16 18 Z" />
              <path className="i" d="M60 -8 V18" />
            </g>
            <g className="rb-prop rb-balloon">
              <path className="i b" d="M82 78 C92 72 95 62 93 52" />
              <path className="i" d="M93 52 C98 42 88 34 92 24" />
              <ellipse className="i rb-fill" cx="92" cy="4" rx="15" ry="19" />
              <path className="i" d="M89 23 l3 4 l3 -4" />
            </g>
            <g className="rb-body">
              <path className="i b rb-leg l" d="M50 105 V119 M44 120.5 h11" />
              <path className="i b rb-leg r" d="M70 105 V119 M65 120.5 h11" />
              <path className="i b rb-arm l" d="M38 78 C29 84 29 92 32 98" />
              <path className="i b rb-arm r" d="M82 78 C91 84 91 92 88 98" />
              <path className="i b rb-reach" d="M39 76 C29 62 29 38 33 17 M81 76 C91 62 91 38 87 17" />
              <rect className="i b bg" x="38" y="66" width="44" height="40" rx="13" />
              <path className="i s" d="M50 80 h20 M50 89 h12" />
              <path className="i b" d="M60 66 V61" />
              {gear === "bow" && <path className="i rb-fill" d="M60 68 l-10 -6 v12 Z M60 68 l10 -6 v12 Z" />}
            </g>
            <g className="rb-head">
              <rect className="i b bg" x="35" y="28" width="50" height="34" rx="14" />
              <g className="rb-eyes">
                <ellipse className="f rb-eye" cx="52" cy="44" rx="3.6" ry="4.6" />
                <ellipse className="f rb-eye" cx="68" cy="44" rx="3.6" ry="4.6" />
              </g>
              <path className="i rb-mouth" d="M54 53 Q60 57 66 53" />
              {gear === "shades" && <><path className="f" d="M42 38 h16 v7 q0 5 -5 5 h-6 q-5 0 -5 -5 Z M62 38 h16 v7 q0 5 -5 5 h-6 q-5 0 -5 -5 Z" /><path className="i" d="M57 40 h6 M36 40 h6 M78 40 h6" /></>}
              {gear === "tophat" && <><path className="i b bg" d="M46 28 V8 h28 V28" /><path className="i b" d="M37 28 h46" /><path className="i rb-ink" d="M47 21 h26" /></>}
              {gear === "crown" && <path className="i rb-fill" d="M44 28 V12 l8 9 l8 -11 l8 11 l8 -9 V28 Z" />}
              {gear === "cap" && <><path className="i b rb-fill" d="M43 29 Q60 6 77 29 Z" /><path className="i" d="M60 17 V10" /><path className="i b rb-spin" d="M48 9 h24" /></>}
              {gear === "phones" && <><path className="i b" d="M35 42 V38 Q35 18 60 18 Q85 18 85 38 V42" /><rect className="f" x="29" y="38" width="8" height="15" rx="3.5" /><rect className="f" x="83" y="38" width="8" height="15" rx="3.5" /></>}
            </g>
            <g className="rb-prop rb-balls">
              <circle className="i rb-fill rb-jug" cx="60" cy="64" r="5" />
              <circle className="i rb-fill rb-jug" cx="60" cy="64" r="5" />
              <circle className="i rb-fill rb-jug" cx="60" cy="64" r="5" />
            </g>
            <g className="rb-prop rb-stars">
              <g className="rb-orbit">
                <path className="i" d="M42 14 l2 -4 l2 4 l4 2 l-4 2 l-2 4 l-2 -4 l-4 -2 Z" />
                <path className="i" d="M74 10 l2 4 l4 2 l-4 2 l-2 4 l-2 -4 l-4 -2 l4 -2 Z" />
                <path className="i" d="M60 -2 v1 M60 31 v1" />
              </g>
            </g>
          </g>
          <path className="i rb-bang" d="M100 34 v12 M100 53 v1" />
        </g>
      </svg>
      <div ref={grip} className="rb-hit" />
    </div>
  );
}
