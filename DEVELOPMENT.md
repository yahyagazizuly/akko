# Akko — developer notes

What's built, how it works and how not to break it. The user-facing overview is in [README.md](README.md).

## What it is

Akko is a tiny ink-drawn robot who runs around the screen: ~50 tricks (jetpack, balloon, wall climb, cartwheel,
ball…). His eyes follow the cursor, and you can grab and throw him. He started as a React component for a website
(`HopBot.tsx` / `HopBot.css` in the root — **the original, left untouched**). Now he is:

1. **A library**, `core/` — zero dependencies, for any website or app.
2. **A macOS app**, `mac/` — native (Swift + the system WebKit). **Done, installed, working.**
3. **A Windows app**, `desktop/` — Electron. **Code written, not yet built or run on Windows.**

## Layout

```
core/            the akko library (TypeScript → dist/ via esbuild)
  src/engine.ts    behaviour: picking tricks, walking, jumping, throwing, feelings, food (ported from HopBot.tsx without React)
  src/index.ts     public API createAkko(), pause/hide, ink mode
  src/art.ts       the drawing: every moving part is an HTML block with its own small SVG; 3 copies for the "boil"
  src/lines.ts     jitter(): a copy of the drawing with slightly moved points (for the boiling ink)
  src/chelik.css   all styles and poses (generated from HopBot.css, classes chelik-*/rb-*)
  src/react.ts     the <Akko /> wrapper
  demo.html        demo page
mac/             the macOS app
  Sources/main.swift            overlay window, menu bar, hotkey, sleep/battery, settings (UserDefaults)
  Sources/SettingsWindow.swift  settings window (SwiftUI)
  Sources/AutoHide.swift        when to hide: video, full screen, screen recording / sharing
  Sources/World.swift           the "world": windows (front to back), Dock, desktop icons → into the page on change
  Sources/Sight.swift           "eyes": finds visible window edges, the Dock and icons with Screen Recording
  Sources/Senses.swift          what happens on the computer: apps, music, notifications, power, typing
  Sources/FrameCap.swift        frame cap for animations (60, 30 when saving power) — eases WindowServer
  web/overlay.html, bridge.js   the page inside WebKit, the JS ↔ Swift bridge
  build.sh                      builds the .app (arm64 + x86_64) and a .dmg into mac/build/
desktop/         Electron version (for Windows): main.js, preload.js, overlay.*
scripts/         icons.py (icons: just the head, no antenna), sync-core.mjs (copies the library into desktop/)
```

## Commands

```bash
cd core && npm install && npm run build               # library → core/dist
python3 -m http.server -d core 5178                   # demo: http://localhost:5178/demo.html
cd mac && ./build.sh --run                            # build and run the macOS app
ditto "mac/build/Akko.app" "/Applications/Akko.app"   # install
cd desktop && npm install && npm start                # Electron
cd desktop && npm run dist:win                        # Windows installer (untested)
```

## How the macOS app works

- A transparent panel covers the screen below the menu bar, above other windows, and never takes focus. He walks
  along the very bottom of the screen (in front of the Dock too); the Dock is just something he sometimes hops onto
  (the `dock` trick, the `upDock` flag).
- **The world around him** (`World.swift`, setting "Climb windows and the Dock", `climb`): once a second (2 s when
  saving power) the app asks WindowServer for window frames (`CGWindowListCopyWindowInfo`, ~0.35 ms, no permission
  needed) and hands them to the page as `desk.world({b:[[id, kind, x, y, w, h]…]})` — only when something changed.
  Kind: 0 window, 1 icon, 2 Dock. While he stands on a window (JS sends `perch`) it polls 10×/s so he rides along.
  Without permissions the Dock width is estimated from its settings (tile count × size); with Accessibility we take
  the exact frame (AX: the Dock process's list) and the desktop icons (AX: images in Finder's scroll area).
  AX queries run in the background every 6 s, so a slow Finder never stalls the app.
- **Eyes** (`Sight.swift`, needs Screen Recording, button in the World tab): Akko learns shapes himself, no tuned
  numbers. For each new window he captures a thin strip at its top (ScreenCaptureKit, that window only, no shadow)
  and finds the first solid row — the visible top — and column — the side; World shrinks the frame to the visible
  one. Every 20 s he captures the Dock window (only its panel is visible → its frame; no panel → the Dock is hidden)
  and Finder's desktop window (only icons there → blobs of the right size = icons). Only transparency is read, in
  memory. Without permission: estimates (Dock width from settings, icons via Accessibility). Log: `chelik sight: …`.
  The permission (like Accessibility) resets with every new ad-hoc-signed build.
- **Ground underfoot** (`below()` in the engine): when falling (jumped off, thrown, the window moved away) he lands
  on the nearest surface below — a visible window top, an icon, the Dock or the floor. Jumping forward off a window,
  he can't land on the same window or the ones behind it. Once on a roof he carries on up there (the `perched` trick).
- In the engine (`engine.ts`, section "On the desktop"): tricks `climb` (onto a window: up the side, a big jump or
  by jetpack), `icons`, `dock`. Up top he walks, sits, dangles his legs, hides behind a window lying on top and peeks
  out; drag the window and he rides (`ride`), close/minimise it and he falls. "Behind a window" is a `clip-path` on
  Akko's root: the visible part of the screen, cut in strips along the edges of the windows in front; it is set once
  per change, not every frame (measured: walking with clipping costs the same, ~5%).
- While he is on the Dock only tricks from `ON_DOCK` are picked; a floor trick ordered from the menu makes him hop
  down first. Thrown onto the Dock from above with the mouse, he lands on it.
- **Feelings** (`engine.ts`, "How he feels"): energy, mood and fullness, all 0…1, saved in localStorage
  (`<storageKey>:mood`) and reported through `onMood`. Tricks spend energy; naps and coffee restore it. Mood rises
  with attention and food and sinks when he's ignored or hungry. Fullness wears off over ~4 hours.
- **Food** (`engine.ts`, "Food"): `feed()` (the app's *Throw food* button) drops a snack onto the floor; calls pile
  up (up to 15). The `eat` act walks to the nearest snack, eats it (+fullness, +energy, +mood) and goes on until
  he's full. A snack he doesn't reach within 5 s of landing fades away and he says "oops" (`missed`); eating comes
  before any other trick while he's hungry. Hungry, he hints at a snack (`hungry`).
- The settings window is compact: a header (status, trick, pause, show) and tabs *Akko / Character / World / System*.
  The `CHELIK_SNAP` hook also saves a picture of the settings window (`settings.png`); `CHELIK_TAB=n` opens a tab.
- Clicks pass through. Swift sleeps until the mouse moves (a global mouse-move monitor, no permission needed), then
  follows the cursor 30×/s for 0.4 s; plus a safety check every 0.5 s. JS reports when the cursor is over Akko
  (`onInteractive`), and only then does the panel start catching the mouse.
- Controls: the head icon in the menu bar, the settings window (opens when the app is launched again, or on the very
  first launch), hotkey ⌘⌥⇧M.
- **Hides on his own**: while some app keeps the display awake (`IOPMCopyAssertionsByProcess`: video and calls do
  this) and when the front app is a full-screen game, presentation or video. Screen recording and sharing are checked
  first (the ⌘⇧5 / QuickTime toolbar, OBS, Kap, Screen Studio, Zoom's share helper): by default he stays out then,
  even though recorders also keep the display awake. Sharing from a browser tab can't be seen from outside. He comes
  back after 6 s of quiet.
- Paused / hidden / locked / asleep → the engine is stopped, CSS animations are paused, ~0% CPU.
- Power saving "Auto" = on battery or in Low Power Mode: 30 fps and no ink boil.
- Settings: `defaults read dev.minichelik.mac`. While the app is running, change them only through the app itself:
  on quit it overwrites values written with `defaults write`.

## Performance — hard-won lessons (don't break these!)

Numbers are % of one core on a MacBook Pro M3 Pro (sum of three processes: the app + WebKit WebContent + WebKit
GPU), cursor still. "Before" is the version before the 2026-11-17 optimisation.

| Mode | Before | After | Memory (3 processes) |
|---|---|---|---|
| paused / hidden | ~0% | ~0% | ~42 MB |
| standing (breathing, blinking, ink) | 14% | 2.5% | ~45 MB |
| walking / running | 27% | 5% | ~52 MB |
| normal life (tricks back to back) | 27% | 7% | ~52 MB (was up to 160) |
| same, power saving | 19% | 4% | ~50 MB |

Plus the system WindowServer: while anything animates, it redraws the screen. At 120 Hz that was ~+19% of a core,
with a 60 fps cap ~+12%, at 30 fps (power saving) ~+7%.

The main WebKit rule: **everything that moves must be an animation played by the GPU, not by script.**
Any change to the page from JS (a class, a style, an attribute, a new element) costs ~4 ms of redraw, however small.
So what matters is the number of such changes per second, not their size.

1. **Every moving part is its own HTML block** (`.rb-p`) with its own small SVG on a shared 72×104 grid
   (`--q` is one grid cell; keyframe offsets use it too). WebKit redraws animations inside one SVG every frame;
   HTML blocks are moved by the GPU, ~0%.
2. **Walking** (`go` in engine.ts) is computed ahead of time and handed to the browser as Web Animations: speed-up,
   one step on a loop (iterations) and slow-down. Keyframes only at the step's points, a sine curve in between.
   WebKit runs hundreds of keyframes on the main thread — don't.
3. **Boiling ink** = 3 ready copies of the drawing with slightly moved points, swapped by a CSS opacity animation
   (zero script). `ink: true` / `"lines"` is this; `"filter"` is the old noise filter (costly, only on request).
4. **Blinking** is one long 13 s CSS loop with several blinks (not a JS timer).
5. **No `animation-direction: alternate-reverse`**: WebKit won't hand it to the GPU. Use `alternate` with a negative
   delay of one cycle instead. And all keyframes of one animation must have the same list of transform functions
   (e.g. `translateY(..) rotate(..)` everywhere, not `none` in one frame).
6. **Don't remove things from the page**: removing a layer makes WebKit keep a picture of the whole page (~55 MB on a
   full-screen overlay). Dust, flashes, the ball, the paper plane and the speech bubble are created once and then
   only hidden/shown (`pooled()` in engine.ts). All effects have `will-change`.
7. **The speech bubble** doesn't follow him by script: it gets the same movement animations as Akko (`carry`).
8. **Eyes** look at the cursor on a timer (often when it's near and moving, rarely when it's far or still);
   CSS transitions smooth it. No requestAnimationFrame loops unless he's being dragged.
9. **The jetpack trail** is a CSS exhaust inside Akko (`.rb-exhaust`), not script sparks (was 23%, now 8%).
10. **WebKit flags in main.swift:** `AcceleratedDrawingEnabled = false` (otherwise any SVG redraw holds ~110 MB of
    GPU buffers) and `PreferPageRenderingUpdatesNear60FPSEnabled = true`.
11. **FrameCap.swift**: every CAAnimation WebKit adds in this process gets a `preferredFrameRateRange` (60, 30 when
    saving power). Otherwise WindowServer draws the screen at 120 Hz.
12. Writing to localStorage ("which tricks has he done") happens every 30 s and on stop, not after every trick.

Measuring: `top -pid` on the "Akko", `com.apple.WebKit.GPU` and `com.apple.WebKit.WebContent` processes (and
`WindowServer` — app off / on); memory — `footprint <pid>` (the "graphics" line is layer images).
Run with `CHELIK_NO_CURSOR=1` so the mouse doesn't skew the numbers. To check a single action:
`CHELIK_EVAL='desk.chelik.pause(); …'` and then set the pose/animation by hand.

## Debugging

- `CHELIK_EVAL="js"` — run JS in the page after it loads; `desk.chelik` (the library instance), `desk.play("jetpack")`
  and `desk.feed()` are available.
- `CHELIK_WK_OFF="Flag1,Flag2"` — turn WebKit flags off for experiments.
- `CHELIK_NO_CURSOR=1` — don't feed the cursor (for measurements).
- `CHELIK_FPS=n` — animation frame cap (0 — uncapped, i.e. 120 on ProMotion).
- `CHELIK_FRAME="x,y,w,h"` — put the window in the given rectangle.
- `CHELIK_SNAP=/folder` — the page can ask for a picture of itself:
  `window.webkit.messageHandlers.desk.postMessage({t:"snap", n:"name", r:[x,y,w,h]})` → `/folder/name.png`.
  A way to look at Akko without Screen Recording access.
- Logs: run `"/Applications/Akko.app/Contents/MacOS/Akko"` from a terminal. stderr gets lines like `chelik act: …`,
  `chelik autohide: …`, `chelik js: …` (JS errors too). They don't show up in the system log.
- In the library `chelik.play()` returns the list of tricks, `chelik.play("name")` starts one right away.

## Fixed bugs (don't bring them back)

- **Hang with a spinning cursor** (November 2026): the main thread got stuck in `CA::Context::commit_transaction`
  while a SkyLight background thread was destroying a window (`-[CAContext dealloc]`) — a deadlock inside the system.
  The cause: `FrameCap` modified *every* animation in the app (settings window, menus, tooltips), and the animation
  object in place at that. Now it only touches layers inside Akko's web view (`FrameCap.root`) and changes a copy.
  `.help` tooltips were removed from settings — keep them out. The `CHELIK_CAPLOG=1` hook logs how many animations
  were capped.
- On the desktop `targets: ""` → `querySelectorAll("")` threw, and Akko just stood there. Now an empty selector means
  no targets, and after an error the engine waits 1 s instead of spinning.
- Brave releases and re-takes its "keep the display awake" request → Akko flickered. Hence the 6 s delay before
  coming back.
- After the optimisation, the speech bubble and effects are hidden rather than removed. Bring back `el.remove()` and
  you bring back +55 MB of memory.
- Screen recorders keep the display awake, so Akko used to vanish as soon as a recording or a Zoom share started.
  Now recording is checked first and has its own switch.

## Not done yet / ideas

- Desktop icons via Accessibility are written but untested live: the build had no access.
  With ad-hoc signing every new build loses granted access — it has to be granted again.
- Dock width without access is an estimate (minimised windows aren't counted, so it comes out a bit narrower).
- He gets onto windows only by himself; thrown with the mouse, he doesn't land on a window (only the floor and the Dock).
- Detect screen sharing from browsers (Google Meet) and other call apps.
- **Windows**: build (`npm run dist:win`) and test on a Windows machine. Check click-through and grabbing, port
  auto-hiding and the settings window (there's only a tray menu there now).
- Code signing: builds are unsigned (on macOS, first launch is right-click → Open). Shipping to people needs an Apple
  Developer ID and notarisation.
- The library isn't published to npm yet (`core/package.json` is ready, name `akko`).
- Further savings: 30 fps in normal mode too (WindowServer −5% of a core, slightly less smooth motion).
- Remaining frequent script changes: pose and gaze changes (~2–4 ms each). Cheaper only by making poses full CSS
  animations with no class change.
- Debug logs (`NSLog`, `post({t:"log"})`) and the `CHELIK_*` hooks are left in on purpose; they're cheap.
