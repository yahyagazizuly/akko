import { createChelik, FLOOR_ACTS } from "./vendor/akko.js";

const desk = window.desk;

const chelik = createChelik({
  targets: "",          // no web page here, so no elements to climb
  page: null,
  trackPointer: false,  // the window is click-through, so the app feeds the cursor
  storageKey: "chelik:desktop:seen",
  ink: "lines",         // hand-drawn wobble without the costly noise filter
  autoStart: false,
  respectReducedMotion: false, // the user launched the pet on purpose: "Reduce motion" must not freeze him
  lang: (navigator.language || "").toLowerCase().startsWith("ru") ? "ru" : "en", // tray menu is Russian; match the phrases
  // Pointer over him → let clicks in so he can be poked and thrown; otherwise clicks pass through.
  onInteractive: (on) => desk.interactive(on),
  onAct: (name) => desk.act(name),
});

desk.acts(FLOOR_ACTS);
desk.onCursor((x, y) => chelik.pointer(x, y));
desk.onPlay((name) => chelik.play(name));
let lowPower = false;
desk.onState((s) => {
  chelik.set({ size: s.size });
  if (!!s.lowPower !== lowPower) { lowPower = !!s.lowPower; chelik.set({ lowPower }); }
  if (s.running) chelik.resume(); else chelik.pause();
});
