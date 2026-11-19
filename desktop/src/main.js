// Akko for the desktop: a transparent, click-through window over the whole screen. Clicks pass
// straight through to whatever is below, except on the little guy himself (so he can be poked and thrown).
// He is controlled from the tray / menu bar icon and a global shortcut.

const { app, BrowserWindow, Tray, Menu, screen, ipcMain, globalShortcut, powerMonitor, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const isMac = process.platform === "darwin";
const SHORTCUT = "CommandOrControl+Alt+Shift+M";
const ICONS = path.join(__dirname, "..", "assets");

// ---- Keep it light: one renderer, nothing in the background that isn't needed.
app.commandLine.appendSwitch("disable-features", "HardwareMediaKeyHandling,MediaSessionService,SpareRendererForSitePerProcess");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=64");
if (isMac) app.dock?.hide(); // lives in the menu bar only

// A second copy just pokes the first one (see "second-instance") and leaves. app.quit() is async, so the
// ready handler below also checks this, or the second copy would briefly put up its own window and tray.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

// ---- Settings, saved next to the app's other data.
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
const defaults = { visible: true, paused: false, size: 44, power: "auto", displayId: null };
let settings = { ...defaults };
const load = () => { try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) }; } catch { /* first run */ } };
let saveTimer = null;
const flush = () => { clearTimeout(saveTimer); saveTimer = null; try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* read-only */ } };
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 300); };

let win = null, tray = null, acts = [], lastAct = "";
let systemPaused = false; // locked screen / sleep: pause regardless of the user's choice
let interactive = false;

const pickDisplay = () => screen.getAllDisplays().find((d) => d.id === settings.displayId) ?? screen.getPrimaryDisplay();
/** He walks on the top of the Dock / taskbar: the window is exactly the display's work area. */
const fit = () => { if (win) win.setBounds(pickDisplay().workArea); };

const lowPower = () => settings.power === "on" || (settings.power === "auto" && powerMonitor.isOnBatteryPower());
const send = (ch, ...a) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); };
const pushState = () => send("state", { size: settings.size, lowPower: lowPower(), running: settings.visible && !settings.paused && !systemPaused });

function createWindow() {
  const wa = pickDisplay().workArea;
  win = new BrowserWindow({
    ...wa,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // never steals focus from what you're doing
    alwaysOnTop: true,
    show: false,
    roundedCorners: false,
    acceptFirstMouse: true, // macOS: the first click grabs him, no "activate window" click needed
    type: isMac ? "panel" : "toolbar",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  // The overlay never leaves overlay.html: a file dropped on him (or any link) would otherwise load over the
  // whole screen, on top of everything.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // A crashed renderer must not leave a full-screen window that eats every click.
  win.webContents.on("render-process-gone", () => {
    interactive = false;
    if (win && !win.isDestroyed()) { win.setIgnoreMouseEvents(true, { forward: true }); setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 1000); }
  });
  // State on every (re)load, so the page never sits waiting for its first "state".
  win.webContents.on("did-finish-load", pushState);
  win.loadFile(path.join(__dirname, "overlay.html"));
  // fit() again once shown: on Windows a window created on a display with another DPI scale comes out the wrong size.
  win.once("ready-to-show", () => { fit(); if (settings.visible) win.showInactive(); pushState(); });
  win.on("closed", () => { win = null; });
}

// ---- The cursor: polled here (cheap) and sent over, since a click-through window gets no mouse moves.
let cursorTimer = null, lastCur = "";
const pollCursor = () => {
  if (!win || !win.isVisible()) return;
  const p = screen.getCursorScreenPoint(), b = win.getBounds();
  const key = `${p.x},${p.y}`;
  if (key === lastCur) return;
  lastCur = key;
  send("cursor", p.x - b.x, p.y - b.y);
};
const setCursorPolling = () => {
  clearInterval(cursorTimer);
  cursorTimer = null;
  const on = settings.visible && !settings.paused && !systemPaused;
  if (on) cursorTimer = setInterval(pollCursor, lowPower() ? 66 : 33);
};

function apply() {
  if (!win) return;
  const running = settings.visible && !settings.paused && !systemPaused;
  if (settings.visible) { if (!win.isVisible()) win.showInactive(); } else if (win.isVisible()) win.hide();
  if (!running && interactive) { interactive = false; win.setIgnoreMouseEvents(true, { forward: true }); }
  pushState();
  setCursorPolling();
  buildMenu();
  save();
}

// ---- Tray / menu bar.
function trayIcon() {
  const img = nativeImage.createFromPath(path.join(ICONS, isMac ? "trayTemplate.png" : "tray.png"));
  if (isMac) img.setTemplateImage(true);
  return img;
}

const ACT_LABELS = {
  jetpack: "Джетпак 🚀", balloon: "Шарик 🎈", wall: "По стене", cartwheel: "Колесо", moonwalk: "Лунная походка",
  dance: "Танец", juggle: "Жонглировать", nap: "Поспать", ball: "Мячик ⚽", plane: "Самолётик", giant: "Великан",
  tiny: "Малыш", dig: "Закопаться", pogo: "Попрыгать", wrap: "Убежать за край", gear: "Переодеться", head: "Потерять голову",
  wave: "Помахать", flip: "Сальто", chase: "Поймать курсор",
  treat: "Угостить печенькой 🍪", knock: "Постучать в экран 👀", jacks: "Зарядка 💪", think: "Задуматься 🤔",
  butterfly: "Бабочка 🦋", bubbles: "Мыльные пузыри 🫧", kungfu: "Кунг-фу 🥋", peekaboo: "Ку-ку", skate: "Покататься ⛸",
  weather: "Погода за окном ❄️", magic: "Фокус с кроликом 🎩", glitch: "Сломаться (понарошку) 👾", selfie: "Селфи 📸",
  breakdance: "Брейк-данс", disco: "Дискотека 🪩", drum: "Барабаны 🥁", spy: "Шпион 🕵️", teleport: "Телепорт ✨",
  meditate: "Медитация 🧘", hiccup: "Икота", kite: "Воздушный змей 🪁", raindance: "Танец дождя ☂️", fishing: "Рыбалка 🎣",
  guitar: "Гитара 🎸", ghost: "Привидение 👻", photo: "Сфоткать курсор 📷", build: "Построить по сезону ⛄",
  bubblegum: "Жвачка", coffee: "Кофе и зумис ☕", banana: "Банановая кожура 🍌", sleepwalk: "Лунатик",
};

function buildMenu() {
  if (!tray) return;
  const running = settings.visible && !settings.paused && !systemPaused;
  const sizes = [[32, "Маленький"], [44, "Обычный"], [60, "Большой"], [84, "Огромный"]];
  const displays = screen.getAllDisplays();
  const trickNames = Object.keys(ACT_LABELS).filter((n) => !acts.length || acts.includes(n));
  const menu = Menu.buildFromTemplate([
    { label: running ? "Акко гуляет" : systemPaused ? "Акко спит (экран заблокирован)" : settings.visible ? "Акко на паузе" : "Акко спрятан", enabled: false },
    { type: "separator" },
    { label: settings.visible ? "Спрятать" : "Показать", accelerator: SHORTCUT, click: () => { settings.visible = !settings.visible; apply(); } },
    { label: "Пауза", type: "checkbox", checked: settings.paused, enabled: settings.visible, click: (i) => { settings.paused = i.checked; apply(); } },
    { label: "Сделать трюк", enabled: running, submenu: [
      { label: "Случайный", click: () => send("play", trickNames[Math.floor(Math.random() * trickNames.length)]) },
      { type: "separator" },
      ...trickNames.map((n) => ({ label: ACT_LABELS[n], click: () => send("play", n) })),
    ] },
    { type: "separator" },
    { label: "Размер", submenu: sizes.map(([s, l]) => ({ label: l, type: "radio", checked: settings.size === s, click: () => { settings.size = s; apply(); } })) },
    { label: "Экономия энергии", submenu: [
      { label: "Авто (на батарее)", type: "radio", checked: settings.power === "auto", click: () => { settings.power = "auto"; apply(); } },
      { label: "Всегда", type: "radio", checked: settings.power === "on", click: () => { settings.power = "on"; apply(); } },
      { label: "Выключена", type: "radio", checked: settings.power === "off", click: () => { settings.power = "off"; apply(); } },
    ] },
    ...(displays.length > 1 ? [{ label: "Экран", submenu: displays.map((d, i) => ({
      label: `${d.label || `Экран ${i + 1}`} (${d.size.width}×${d.size.height})`, type: "radio",
      checked: pickDisplay().id === d.id, click: () => { settings.displayId = d.id; fit(); apply(); },
    })) }] : []),
    { label: "Запускать при входе", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, enabled: app.isPackaged,
      click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { type: "separator" },
    ...(lastAct ? [{ label: `Сейчас: ${ACT_LABELS[lastAct] ?? lastAct}`, enabled: false }] : []),
    { label: "Выйти", accelerator: isMac ? "Command+Q" : undefined, click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(running ? "Акко" : "Акко (пауза)");
}

// ---- Messages from the overlay.
ipcMain.on("interactive", (_e, on) => {
  on = !!on;
  if (!win || on === interactive) return;
  interactive = on;
  win.setIgnoreMouseEvents(!on, { forward: true });
});
ipcMain.on("acts", (_e, list) => { acts = Array.isArray(list) ? list.filter((n) => typeof n === "string") : []; buildMenu(); });
ipcMain.on("act", (_e, name) => { if (typeof name !== "string" || name === lastAct) return; lastAct = name; buildMenu(); }); // keep "Сейчас: …" current

app.whenReady().then(() => {
  if (!primary) return;
  load();
  createWindow();
  tray = new Tray(trayIcon());
  if (!isMac) tray.on("click", () => { settings.visible = !settings.visible; apply(); });
  buildMenu();
  setCursorPolling();
  globalShortcut.register(SHORTCUT, () => { settings.visible = !settings.visible; apply(); });

  // Screen changes: keep him on the right display with the right floor.
  for (const ev of ["display-added", "display-removed", "display-metrics-changed"]) screen.on(ev, () => { fit(); buildMenu(); });
  // Power: lighter on battery, asleep while the screen is locked or the computer sleeps.
  powerMonitor.on("on-battery", apply);
  powerMonitor.on("on-ac", apply);
  for (const ev of ["lock-screen", "suspend"]) powerMonitor.on(ev, () => { systemPaused = true; apply(); });
  for (const ev of ["unlock-screen", "resume"]) powerMonitor.on(ev, () => { systemPaused = false; apply(); });
});

app.on("second-instance", () => { settings.visible = true; settings.paused = false; apply(); });
app.on("will-quit", () => { globalShortcut.unregisterAll(); if (saveTimer) flush(); }); // a change made just before "Выйти" is kept
app.on("window-all-closed", () => app.quit());
