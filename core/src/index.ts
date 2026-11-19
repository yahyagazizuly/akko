import css from "./chelik.css";
import { ART, FILTERS, renderGear, type Gear } from "./art";
import { startEngine, setLang, type WorldBlock, type Sense, type Senses, type Traits } from "./engine";

export type { Gear, WorldBlock, Sense, Traits };

export type ChelikOptions = {
  /** Where to put him. Default: document.body. */
  root?: HTMLElement;
  /** His character: how active and how chatty he is, and a few habits. Changeable any time with set(). */
  traits?: Partial<Traits>;
  /** Called when his energy or mood changes noticeably (both 0…1). */
  onMood?: (m: { energy: number; mood: number }) => void;
  /** The language he speaks: "en" (default) or "ru". */
  lang?: "en" | "ru";
  /**
   * CSS selector of page elements he may jump on, hang from and tug. "" turns that off.
   * Default: elements marked `data-chelik` plus the main headings.
   */
  targets?: string;
  /** Element the page "shakes" (giant stomps, shoving). Default: <main>, if any. null turns it off. */
  page?: HTMLElement | null;
  /** Scrolling element to watch; a scroll mid-trick cancels it. Default: the document. */
  scroller?: HTMLElement | null;
  /** Selector of a fixed widget (e.g. a chat button) to stop walking short of. */
  avoid?: string;
  /** Selector of a theme switch he may jump on and flip (he always flips it back). */
  themeToggle?: string;
  /** Width in px (height follows). Default 44. */
  size?: number;
  colors?: { bg?: string; ink?: string; accent?: string };
  /**
   * Boiling-ink wobble. true / "lines": the lines themselves are redrawn slightly differently a few times a
   * second — a hand-drawn feel that costs next to nothing. "filter": a noise filter instead (matches site art drawn
   * with the same filter, but it is redrawn on every frame he moves, which is costly). false: still lines.
   * Default true.
   */
  ink?: boolean | "filter" | "lines";
  /** Frame cap for the few things stepped by script (dragging him, the ball). Default 60. */
  fps?: number;
  /** Low power preset: no ink wobble, and the few things stepped by script (dragging, the ball) run at 30 fps. */
  lowPower?: boolean;
  /** Listen to pointermove on the window. Turn off to feed the cursor yourself with `pointer(x, y)`. */
  trackPointer?: boolean;
  /** Wave hello when he appears. Default true. */
  greet?: boolean;
  /** Stand still when the user asks for reduced motion. Default true. */
  respectReducedMotion?: boolean;
  /** localStorage key for "which tricks has he done" so he keeps doing new ones. */
  storageKey?: string;
  /** Start running right away. Default true. */
  autoStart?: boolean;
  /** Called with true when the pointer is over him (or he is held) and false when it leaves. */
  onInteractive?: (on: boolean) => void;
  /** Called with each act's name as it starts. */
  onAct?: (name: string) => void;
  /** Called with true when he stands on a window from `world()` (watch it closely and feed its moves) and false when he leaves. */
  onPerch?: (on: boolean) => void;
};

export type Chelik = {
  /** Root element (holds the bot, its effects and the filters). */
  readonly el: HTMLElement;
  /** Names of all the things he can do. */
  readonly acts: string[];
  readonly running: boolean;
  readonly visible: boolean;
  start(): void;
  /** Freeze in place. Nothing animates and nothing runs, so it costs nothing. */
  pause(): void;
  resume(): void;
  /** Pause/resume. */
  toggle(): void;
  show(): void;
  /** Hide and pause. */
  hide(): void;
  /** Do one act right now (e.g. "jetpack"). Returns the list of acts. */
  play(name?: string): string[];
  /** Feed the cursor position (viewport px) when `trackPointer` is false. */
  pointer(x: number, y: number): void;
  /**
   * Feed the desktop around him (a desktop overlay): windows front to back, desktop icons and the Dock, as
   * [id, kind, x, y, w, h, on?] in page px (kind 0 window, 1 icon, 2 Dock, 3 ledge: the top edge of something drawn
   * on screen, `on` the id of the window it is drawn in, -1 on a menu above all windows). He climbs them, hides behind windows in front
   * and rides along when one moves. null forgets it.
   */
  world(list: ([number, number, number, number, number, number] | [number, number, number, number, number, number, number])[] | null): void;
  /**
   * Tell him what is going on on the computer (a desktop overlay): the app in front, a new window, music playing,
   * a notification, the charger, a screenshot, the person away or back. He reacts in his own way.
   */
  sense(e: Sense): void;
  /** Change options on the fly (size, colors, ink, fps, lowPower, targets…). */
  set(opts: Partial<ChelikOptions>): void;
  /** Remove him and everything he left behind. */
  destroy(): void;
};

const STYLE_ID = "chelik-styles";
const FILTERS_ID = "chelik-filters";
let mounted = 0;

/** The acts he can do without any page around him (on a desktop overlay, for example). */
export const FLOOR_ACTS = [
  "walk", "run", "idle", "look", "wave", "hop", "head", "nap", "dance", "yawn", "juggle", "laugh", "sing",
  "edgesit", "flip", "trip", "moonwalk", "sneak", "cartwheel", "dive", "twirl", "pogo", "sneeze", "wrap", "dig",
  "gear", "giant", "tiny", "ball", "plane", "balloon", "jetpack", "wall", "chase", "treat", "knock", "jacks", "think", "butterfly", "bubbles", "kungfu", "peekaboo", "skate", "weather", "glitch", "magic", "selfie", "meditate", "drum", "disco", "spy", "breakdance", "teleport", "hiccup", "kite", "raindance", "fishing", "guitar", "ghost", "photo", "build", "bubblegum", "coffee", "banana", "sleepwalk",
];
/** The acts that need a desktop fed with `world()`. */
export const DESK_ACTS = ["climb", "icons", "dock", "ledges"];

export function createChelik(options: ChelikOptions = {}): Chelik {
  if (typeof document === "undefined") throw new Error("Akko needs a browser (document is undefined)");
  let o: ChelikOptions = {
    targets: "[data-chelik], main h1, main h2",
    size: 44,
    ink: true,
    fps: 60,
    lowPower: false,
    trackPointer: true,
    greet: true,
    respectReducedMotion: true,
    storageKey: "chelik:seen",
    autoStart: true,
    ...options,
  };

  // Styles and filters are shared by every instance on the page.
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }
  const filtered = () => o.ink === "filter" && !o.lowPower;
  const lined = () => (o.ink === true || o.ink === "lines") && !o.lowPower;
  /** The noise filters are only added to the page when someone asks for them. */
  const ensureFilters = () => {
    if (!filtered() || document.getElementById(FILTERS_ID)) return;
    const f = document.createElement("div");
    f.id = FILTERS_ID;
    f.innerHTML = FILTERS;
    (document.body ?? document.documentElement).appendChild(f);
  };
  mounted++;

  const root = document.createElement("div");
  root.className = "chelik-root";
  const dock = document.createElement("div");
  dock.className = "rb-dock";
  dock.setAttribute("aria-hidden", "true");
  dock.innerHTML = ART;
  root.appendChild(dock);
  (o.root ?? document.body ?? document.documentElement).appendChild(root);
  const svg = dock.querySelector(".rb") as HTMLDivElement;
  const hit = dock.querySelector(".rb-hit") as HTMLDivElement;

  let pose = "idle", left = false, gear: Gear = "none";
  const paint = () => {
    const c = `chelik-art rb is-${pose}${left ? " face-left" : ""}`;
    if (svg.getAttribute("class") !== c) svg.setAttribute("class", c);
  };

  const traits: Traits = { activity: 1, chatty: 1, breaks: true, nightSleep: true, follow: true };
  let stop: (() => void) | null = null;
  const apply = () => {
    setLang(o.lang ?? "en");
    Object.assign(traits, o.traits ?? {});
    const s = root.style;
    s.setProperty("--chelik-size", `${o.size}px`);
    // A color taken out with set() goes back to the default.
    for (const k of ["bg", "ink", "accent"] as const) {
      const v = o.colors?.[k];
      if (v) s.setProperty(`--chelik-${k}`, v); else s.removeProperty(`--chelik-${k}`);
    }
    ensureFilters();
    // The reduced-motion rules in the CSS only apply when the page asked to respect that setting.
    root.classList.toggle("chelik-rm", !!o.respectReducedMotion);
    root.classList.toggle("chelik-lite", !filtered());
    // "lines" ink: the three copies of the drawing take turns (a CSS animation, so it stops with everything else on pause).
    root.classList.toggle("chelik-lines", lined());
  };
  apply();

  const mouse: { x: number; y: number; t: number; wake?: () => void } = { x: -1, y: -1, t: 0 };
  const world: { blocks: WorldBlock[] | null; changed?: () => void } = { blocks: null };
  const senses: Senses = { state: { apps: {}, music: false, away: false, plugged: null, low: false, typing: false } };
  let play: (name?: string) => string[] = () => [];
  let acts: string[] = [];
  let visible = true;
  let pending: string | null = null;
  let dead = false;

  const reduced = () => !!o.respectReducedMotion && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const start = () => {
    if (dead || stop || !visible) return;
    root.classList.remove("chelik-paused");
    if (reduced()) return;
    stop = startEngine({
      el: dock, svg, hit, host: root,
      setPose: (p) => { pose = p; paint(); },
      setLeft: (l) => { left = l; paint(); },
      setGear: (g) => { gear = g; renderGear(svg, g); },
      getGear: () => gear,
      targets: o.targets ?? "",
      scroller: o.scroller ?? null,
      page: o.page === undefined ? document.querySelector("main") : o.page,
      avoid: o.avoid ?? "",
      themeToggle: o.themeToggle ?? "",
      storageKey: o.storageKey!,
      fps: o.lowPower ? Math.min(30, o.fps!) : o.fps!,
      trackPointer: !!o.trackPointer,
      greet: !!o.greet,
      mouse,
      world,
      senses,
      traits,
      onMood: (m) => o.onMood?.(m),
      onPerch: (on) => o.onPerch?.(on),
      onInteractive: (on) => o.onInteractive?.(on),
      onAct: (n) => o.onAct?.(n),
      expose: (p) => { play = p; acts = p(); },
    });
    o.greet = false; // only the first time
    if (pending) { play(pending); pending = null; }
  };
  const pause = () => {
    if (!stop) return;
    stop();
    stop = null;
    paint();
    root.classList.add("chelik-paused");
  };
  const restart = () => { if (stop) { pause(); start(); } };

  const api: Chelik = {
    el: root,
    get acts() { return acts.length ? acts : [...FLOOR_ACTS]; },
    get running() { return !!stop; },
    get visible() { return visible; },
    start,
    pause,
    resume: start,
    toggle: () => (stop ? pause() : start()),
    show: () => { if (visible) return; visible = true; root.hidden = false; start(); },
    hide: () => { pause(); visible = false; root.hidden = true; },
    play: (name) => {
      // play() with no name only lists the acts: it must not wake him up.
      if (!stop) { if (name) { pending = name; start(); } return api.acts; }
      return play(name);
    },
    pointer: (x, y) => {
      if (x === mouse.x && y === mouse.y) return;
      mouse.x = x; mouse.y = y; mouse.t = performance.now();
      mouse.wake?.();
    },
    world: (list) => {
      world.blocks = list ? list.map(([id, kind, x, y, w, h, on], z) => ({ id, kind, x, y, w, h, z, on: on || 0 })) : null;
      world.changed?.();
    },
    sense: (e) => {
      const st = senses.state;
      if (e.t === "apps") { st.apps = e.a; return; }
      if (senses.on) { senses.on(e); return; }
      // Paused: no reaction, but remember how things are.
      if (e.t === "music") st.music = e.on;
      if (e.t === "away") st.away = e.on;
      if (e.t === "typing") st.typing = e.on;
      if (e.t === "power") { st.plugged = e.plugged; st.low = !e.plugged && e.level <= 15; }
    },
    set: (patch) => {
      if (dead) return;
      // Keys passed as undefined keep their current value (no "undefinedpx" size, no NaN fps).
      const next = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<ChelikOptions>;
      const needsRestart = ["fps", "lowPower", "targets", "page", "scroller", "avoid", "themeToggle", "trackPointer"].some((k) => k in next);
      o = { ...o, ...next, colors: { ...o.colors, ...next.colors } };
      apply();
      if (needsRestart) restart();
    },
    destroy: () => {
      if (dead) return; // a second destroy() must not take the shared styles away from other instances
      pause();
      dead = true;
      root.remove();
      if (--mounted <= 0) {
        mounted = 0;
        document.getElementById(STYLE_ID)?.remove();
        document.getElementById(FILTERS_ID)?.remove();
      }
    },
  };

  if (o.autoStart) start();
  else root.classList.add("chelik-paused");
  return api;
}

/** The same as createChelik(): the library is called Akko now. */
export const createAkko = createChelik;

export default createChelik;
