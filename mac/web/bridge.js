// Glue between the native macOS shell and the Akko library (loaded before this as window.Akko).
(() => {
  const post = (m) => { try { window.webkit.messageHandlers.desk.postMessage(m); } catch { /* not in the app */ } };
  const { createChelik, FLOOR_ACTS, DESK_ACTS } = window.Akko;

  const chelik = createChelik({
    targets: "",          // no web page here: the desktop comes from the app via desk.world()
    page: null,
    trackPointer: false,  // the window lets clicks through, so the app feeds the cursor
    storageKey: "chelik:desktop:seen",
    ink: "lines",         // hand-drawn wobble without the costly noise filter
    autoStart: false,
    respectReducedMotion: false, // a desktop pet the user launched on purpose: "Reduce motion" must not freeze him
    onInteractive: (on) => post({ t: "interactive", on }),
    onAct: (n) => post({ t: "act", n }),
    onPerch: (on) => post({ t: "perch", on }),
    onMood: (m) => post({ t: "mood", e: m.energy, m: m.mood }),
  });

  let lowPower = null;
  let running = false; // what the app last asked for in desk.state()
  window.desk = {
    cursor: (x, y) => chelik.pointer(x, y),
    // chelik.play() starts a stopped engine: only play while the app has him running, or he would walk on paused/asleep.
    play: (n) => { if (running) chelik.play(n); },
    world: (w) => { chelik.world(w ? w.b : null); if (w && w.a) chelik.sense({ t: "apps", a: w.a }); },
    sense: (e) => chelik.sense(e),
    state: (s) => {
      if (!s) return;
      running = !!s.running;
      chelik.set({ size: s.size, lang: s.lang, traits: s.traits });
      if (s.lowPower !== lowPower) { lowPower = s.lowPower; chelik.set({ lowPower }); }
      if (s.running) chelik.resume(); else chelik.pause();
      post({ t: "log", m: `state running=${s.running} engine=${chelik.running} vis=${document.visibilityState}` });
    },
  };
  window.desk.chelik = chelik; // for poking at it from the developer hook
  addEventListener("contextmenu", (e) => e.preventDefault());
  const err = console.error.bind(console);
  console.error = (...a) => { err(...a); post({ t: "log", m: `console.error: ${a.map(String).join(" ")}` }); };
  addEventListener("error", (e) => post({ t: "log", m: `error: ${e.message} @${e.lineno}` }));
  addEventListener("unhandledrejection", (e) => post({ t: "log", m: `rejection: ${e.reason}` }));
  document.addEventListener("visibilitychange", () => post({ t: "log", m: `visibility: ${document.visibilityState}` }));
  post({ t: "ready", acts: [...FLOOR_ACTS, ...DESK_ACTS] });
})();
