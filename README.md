<div align="center">

<img src="assets/icon.png" width="128" height="128" alt="Akko">

# Akko

**A tiny ink-drawn buddy who lives on your screen.**<br>
He runs, jumps, climbs your windows, flies a jetpack, gets hungry, falls asleep — and never gets in your way.

<br>

![macOS](https://img.shields.io/badge/macOS-13%2B-111?logo=apple&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows&logoColor=white)
![Swift](https://img.shields.io/badge/Swift-macOS-F05138?logo=swift&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-Windows-B7410E?logo=rust&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-library-3178C6?logo=typescript&logoColor=white)
![Size](https://img.shields.io/badge/app-~1–3%20MB-2ea44f)
![License](https://img.shields.io/badge/license-MIT-blue)

<br>

<img src="docs/akko.gif" width="680" alt="Akko waving, flying a jetpack, eating cookies, cartwheeling and floating away on a balloon">

<br><br>

<a href="https://github.com/yahyagazizuly/akko/releases/latest/download/Akko.dmg"><img src="https://img.shields.io/badge/Download_for_macOS-Akko.dmg-111?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS"></a>
<a href="https://github.com/yahyagazizuly/akko/releases/latest/download/Akko-Setup.exe"><img src="https://img.shields.io/badge/Download_for_Windows-Akko--Setup.exe-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows"></a>

<br><br>

[Features](#-features) · [Download](#-download) · [Settings](#%EF%B8%8F-settings) · [Performance](#-performance) · [Library](#-the-akko-library) · [How it works](#-how-it-works)

</div>

---

## ✨ Features

<table>
<tr>
<td width="50%" valign="top">

### 🏃 Lives on your desktop
- Walks along the bottom of the screen and hops onto the **Dock**
- Climbs **windows** — up the side, with a big jump or by jetpack
- Drag a window and he **rides along**; close it and he falls off
- Hides behind windows and peeks out
- Hops across your desktop **icons**

</td>
<td width="50%" valign="top">

### 🎭 50+ tricks
- Jetpack 🚀, balloon 🎈, backflips, cartwheels, moonwalk
- Ball ⚽, juggling, kung fu 🥋, breakdance
- Magic rabbit 🎩, selfies 📸, guitar 🎸, fishing 🎣
- Snowman ⛄ / flower 🌷 / pumpkin 🎃 — by season
- Pretends to crash: *ERROR 404: Akko not found* 👾

</td>
</tr>
<tr>
<td valign="top">

### 👀 Notices what you do
- Switch to a chat app — *"who are you texting? 👀"*
- Music playing — dances with little notes
- A notification arrives — runs over to it
- Screenshot — strikes a pose; charger in — cheers
- Step away — he dozes off

</td>
<td valign="top">

### 💛 Has a life of his own
- **Energy** — tricks use it up, naps and coffee ☕ bring it back
- **Mood** — goes up with attention and snacks, down when ignored
- **Fullness** — throw him food 🍪, as much as you like; he eats until he's full
- Gets bored and comes over to ask you to play
- Reminds you to stretch every ~50 minutes

</td>
</tr>
</table>

You can **poke him, pet him, grab him with the mouse and throw him**. Every click passes straight through to your windows — he only catches the mouse when the pointer is right on him.

---

## 📥 Download

| Platform | File | How |
|---|---|---|
| 🍎 macOS 13+ (Apple Silicon & Intel) | [**Akko.dmg**](https://github.com/yahyagazizuly/akko/releases/latest/download/Akko.dmg) | open it and drag Akko into Applications |
| 🪟 Windows 10 / 11 | [**Akko-Setup.exe**](https://github.com/yahyagazizuly/akko/releases/latest/download/Akko-Setup.exe) | run it — Akko installs and starts by himself |

Nothing else to install. All versions are on the [Releases](https://github.com/yahyagazizuly/akko/releases) page.

> [!TIP]
> **First launch.** The builds aren't notarized yet, so the system asks once.
> **macOS:** right-click Akko → *Open* (or System Settings → Privacy & Security → *Open Anyway*).
> **Windows:** if SmartScreen appears, click *More info* → *Run anyway*.

---

## 📦 Build from source

### macOS — native app

```bash
cd mac && ./build.sh --run
```

This builds `mac/build/Akko.app` and `Akko-0.1.0.dmg`. Open the `.dmg` and drag **Akko** into Applications.

- Universal app: Apple Silicon + Intel, macOS 13+
- Needs only **Xcode Command Line Tools** and **Node.js**
- Settings: launch Akko again (Launchpad or Spotlight), or menu bar icon → *Settings…*
- Show / hide: <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>⇧</kbd> <kbd>M</kbd>

<details>
<summary><b>Permissions (optional)</b></summary>
<br>

- **Screen Recording** — lets Akko find window edges, the Dock and icons himself, and spot input fields and menus he can stand on. He only looks at pixel transparency; nothing is ever saved.
- **Accessibility** — lets him climb desktop folders and icons.

He works without them too: windows are visible anyway, and measurements are remembered per app.
If your keychain has a developer certificate, `build.sh` signs with it, so macOS keeps the permissions across rebuilds.

</details>

### Windows — native app

```bash
cd core && npm install && npm run build && cd ..
cargo build --release --manifest-path win/Cargo.toml   # → win/target/release/akko.exe
```

Rust + the system **WebView2** (built into Windows 10/11) — the same idea as the Mac app: a tiny native shell and the
system web engine, no bundled browser. The installer (`win/installer/akko.iss`, Inno Setup) installs for the current
user without admin rights, adds shortcuts, installs WebView2 if it's missing and starts Akko.

### Releases

Push a tag and GitHub Actions builds both installers and publishes a release:

```bash
git tag v0.1.1 && git push origin v0.1.1
```

---

## ⚙️ Settings

| Tab | What's inside |
|---|---|
| **Akko** | size (S / M / L / XL), phrase language (English / Russian), power saving, when to hide |
| **Character** | activity, chattiness, habits — and **Wellbeing**: energy, mood and fullness bars, *Throw food* and *Give coffee* buttons |
| **World** | climb windows and the Dock / taskbar, react to apps, Screen Recording access (macOS only) |
| **System** | launch at login, menu bar / tray icon |

Both apps have the same settings window. On Windows: tray icon → *Settings…* (or launch Akko again); show / hide with <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>⇧</kbd> <kbd>M</kbd>.

**When he hides on his own**

| Switch | What it does |
|---|---|
| Hide during videos and calls | a player, a browser playing video or a call keeps the display awake, so he steps aside |
| Hide in full-screen games and presentations | a game, Keynote / PowerPoint or a video player fills the screen |
| Hide while recording or sharing the screen | **off** — he stays on screen while you record (<kbd>⌘</kbd><kbd>⇧</kbd><kbd>5</kbd>, QuickTime, OBS, the Snipping Tool) or share in Zoom, great for demos; **on** — he hides from the recording |

Regular apps in full screen (a chat, an editor, a browser) are no reason to hide — he keeps you company.

---

## ⚡ Performance

MacBook Pro M3 Pro, percent of one core (app + WebKit processes):

| Mode | CPU | Memory |
|---|:-:|:-:|
| paused / hidden | ~0% | ~42 MB |
| standing, breathing, blinking | ~2.5% | ~45 MB |
| walking / running | ~5% | ~52 MB |
| normal life, tricks back to back | ~7% (≈0.6% of the whole CPU) | ~52 MB |
| same, power saving (30 fps) | ~4% | ~50 MB |

<details>
<summary><b>How</b></summary>
<br>

- Everything that moves is an animation played by the GPU, not by script
- Every arm, leg, eye and accessory is its own layer; the walk cycle is computed ahead of time
- The "boiling ink" is three pre-drawn copies of the drawing taking turns
- Effects (dust, flashes, the ball, speech bubbles) are created once and then only shown and hidden
- On 120 Hz screens animations are capped at 60 fps (30 when saving power)
- Asleep, locked or paused, everything stops completely
- The cursor is not polled all the time: the app sleeps until the mouse moves

More in [DEVELOPMENT.md](DEVELOPMENT.md#performance--hard-won-lessons-dont-break-these).

</details>

---

## 🧩 The `akko` library

The same Akko for any website or web app. Zero dependencies.

```js
import { createAkko } from "akko";

const akko = createAkko();   // that's it — he's already running along the bottom of the page
```

<details>
<summary><b>No bundler, React and all options</b></summary>
<br>

With a single tag:

```html
<script src="akko.global.js"></script>
<script>const akko = Akko.createAkko();</script>
```

React:

```jsx
import { Akko } from "akko/react";

<Akko size={48} paused={false} onReady={(c) => (window.akko = c)} />
```

Options:

```js
createAkko({
  size: 44,                                   // width in px
  colors: { bg: "#faf8f2", ink: "#151513", accent: "#c2603f" },
  lang: "en",                                 // "en" or "ru"
  targets: "[data-chelik], main h1, main h2", // what he may jump on ("" — nothing)
  page: document.querySelector("main"),       // what shakes when he stomps (null — nothing)
  avoid: ".chat-button",                      // don't walk behind this widget
  themeToggle: ".theme-switch",               // a theme switch he may "press"
  ink: true,                                  // boiling ink: true | "lines" | "filter" | false
  lowPower: false,                            // no ink wobble, 30 fps
  fps: 60,
  greet: true,                                // wave hello on start
  autoStart: true,
  trackPointer: true,                         // false — feed the cursor yourself with pointer(x, y)
  respectReducedMotion: true,                 // stand still with "reduce motion"
  onAct: (name) => {},
  onMood: ({ energy, mood, full }) => {},     // all 0…1
  onInteractive: (on) => {},
  onPerch: (on) => {},
});
```

Mark any element with `data-chelik` and Akko will sit on it, jump on it and slap stickers on it.
`data-chelik-stomp` — he'll press the element when he stomps on it.

Control:

```js
akko.pause();  akko.resume();  akko.toggle();
akko.hide();   akko.show();
akko.play("jetpack");                 // a trick right now; akko.play() lists them all
akko.feed();                          // throw a snack — call it as often as you like
akko.set({ size: 60, lowPower: true });
akko.world([[id, 0, x, y, w, h], …]); // windows (0), icons (1), Dock (2) for desktop apps
akko.destroy();
```

Development:

```bash
cd core && npm install && npm run build   # → core/dist
python3 -m http.server -d core 5178       # demo: http://localhost:5178/demo.html
```

</details>

---

## 🛠 How it works

```
core/       the akko library — TypeScript, zero dependencies
  src/engine.ts     behaviour: tricks, walking, jumping, throwing, feelings, food
  src/art.ts        the drawing: every part is its own layer with its own SVG
  src/chelik.css    poses and animations
  src/react.ts      the <Akko /> wrapper
mac/        the macOS app — Swift + the system WebKit
  Sources/main.swift            overlay, menu bar, hotkey, sleep and battery
  Sources/SettingsWindow.swift  settings window (SwiftUI)
  Sources/World.swift           windows, Dock and icons → into the page
  Sources/AutoHide.swift        when to hide: video, full screen, screen recording
  build.sh                      builds the .app (arm64 + x86_64) and a .dmg
win/        the Windows app — Rust + the system WebView2
  src/main.rs                   overlay, tray, hotkey, settings window, sleep / lock / display
  src/world.rs                  windows, taskbar and desktop icons → into the page
  src/ledges.rs                 input boxes, toolbars, menus inside windows to stand on
  src/senses.rs                 apps, music, power, typing, and when to hide
  web/settings.html             settings window (same as on the Mac)
  installer/akko.iss            one-click installer (Inno Setup)
assets/     app and tray icons
scripts/    icon drawing
HopBot.*    the original React component it all started from
```

Developer notes — architecture, performance rules, debugging hooks — are in [DEVELOPMENT.md](DEVELOPMENT.md).

---

<div align="center">

Made with ☕ by [@yahyagazizuly](https://github.com/yahyagazizuly) · [MIT](LICENSE)

</div>
