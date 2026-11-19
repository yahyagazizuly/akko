// Akko for Windows: a native tray app, the counterpart of the macOS one. A transparent window covers the screen
// (he walks along the bottom and climbs the taskbar, windows and icons) and lets every click through, except
// when the cursor is over him. He is drawn by the Akko library in the system WebView2, so the app is tiny.

#![windows_subsystem = "windows"]

mod senses;
mod settings;
mod util;
mod world;

use settings::Settings;
use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tao::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, DeviceEventFilter, EventLoop, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};
use tao::monitor::MonitorHandle;
use tao::platform::windows::{WindowBuilderExtWindows, WindowExtWindows};
use tao::window::{Icon as WindowIcon, Window, WindowBuilder, WindowId};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tray_icon::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::Power::{POWERBROADCAST_SETTING, RegisterPowerSettingNotification};
use windows::Win32::System::RemoteDesktop::{NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification};
use windows::Win32::System::SystemServices::GUID_CONSOLE_DISPLAY_STATE;
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook};
use windows::Win32::UI::Input::KeyboardAndMouse::{MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, RegisterHotKey};
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DEVICE_NOTIFY_WINDOW_HANDLE, EVENT_SYSTEM_FOREGROUND, FindWindowW, GWL_EXSTYLE, GWLP_WNDPROC, GetCursorPos,
    GetWindowLongPtrW, HWND_TOPMOST, MA_NOACTIVATE, PBT_APMPOWERSTATUSCHANGE, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND,
    PBT_APMSUSPEND, PBT_POWERSETTINGCHANGE, PostMessageW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowLongPtrW, SetWindowPos,
    WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_APP, WM_DISPLAYCHANGE, WM_HOTKEY, WM_MOUSEACTIVATE, WM_POWERBROADCAST,
    WM_SETTINGCHANGE, WM_WTSSESSION_CHANGE, WNDPROC, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WTS_SESSION_LOCK, WTS_SESSION_UNLOCK,
};
use windows::core::{HSTRING, w};
use wry::{WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

const OVERLAY_TITLE: &str = "Akko Overlay";
const WM_SHOW_SETTINGS: u32 = WM_APP + 1;
const HOTKEY: &str = "Ctrl+Alt+Shift+M";

// The page and the library, built into the exe.
const OVERLAY_HTML: &str = include_str!("../../mac/web/overlay.html");
const BRIDGE_JS: &str = include_str!("../../mac/web/bridge.js");
const AKKO_JS: &str = include_str!("../../core/dist/akko.global.js");
const SETTINGS_HTML: &str = include_str!("../web/settings.html");
const ICON_PNG: &[u8] = include_bytes!("../../assets/icon.png");
const ICON32: &[u8] = include_bytes!("../assets/icon32.rgba");
const ICON64: &[u8] = include_bytes!("../assets/icon64.rgba");

#[derive(Debug)]
enum Sys {
    Hotkey,
    Lock(bool),
    Suspend(bool),
    Display(bool),
    DisplayChange,
    Power,
    ShowSettings,
}

#[derive(Debug)]
enum UserEvent {
    World(String),
    Sense(String),
    Signals(senses::Signals),
    Power,
    Cursor(i32, i32),
    Foreground(isize),
    Sys(Sys),
    Tray(TrayIconEvent),
    Menu(MenuEvent),
    OverlayIpc(String),
    SettingsIpc(String),
}

static PROXY: OnceLock<Mutex<EventLoopProxy<UserEvent>>> = OnceLock::new();
static OLD_PROC: AtomicIsize = AtomicIsize::new(0);

fn post(e: UserEvent) {
    if let Some(p) = PROXY.get() {
        let _ = p.lock().unwrap().send_event(e);
    }
}

/// The overlay's window procedure, in front of tao's: the hotkey, lock / sleep / display, never taking focus.
unsafe extern "system" fn overlay_proc(h: HWND, m: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match m {
        // Clicking him must not take focus away from what you are doing.
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_HOTKEY => post(UserEvent::Sys(Sys::Hotkey)),
        WM_SHOW_SETTINGS => post(UserEvent::Sys(Sys::ShowSettings)),
        WM_WTSSESSION_CHANGE => match wp.0 as u32 {
            WTS_SESSION_LOCK => post(UserEvent::Sys(Sys::Lock(true))),
            WTS_SESSION_UNLOCK => post(UserEvent::Sys(Sys::Lock(false))),
            _ => {}
        },
        WM_POWERBROADCAST => match wp.0 as u32 {
            PBT_APMSUSPEND => post(UserEvent::Sys(Sys::Suspend(true))),
            PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => post(UserEvent::Sys(Sys::Suspend(false))),
            PBT_APMPOWERSTATUSCHANGE => post(UserEvent::Sys(Sys::Power)),
            PBT_POWERSETTINGCHANGE if lp.0 != 0 => {
                let s = unsafe { &*(lp.0 as *const POWERBROADCAST_SETTING) };
                if s.PowerSetting == GUID_CONSOLE_DISPLAY_STATE {
                    post(UserEvent::Sys(Sys::Display(s.Data[0] != 0)));
                }
            }
            _ => {}
        },
        WM_DISPLAYCHANGE => post(UserEvent::Sys(Sys::DisplayChange)),
        WM_SETTINGCHANGE => post(UserEvent::Sys(Sys::Power)),
        _ => {}
    }
    let old: WNDPROC = unsafe { std::mem::transmute(OLD_PROC.load(Ordering::Relaxed)) };
    unsafe { CallWindowProcW(old, h, m, wp, lp) }
}

unsafe extern "system" fn foreground_hook(_: HWINEVENTHOOK, _: u32, hwnd: HWND, _: i32, _: i32, _: u32, _: u32) {
    post(UserEvent::Foreground(hwnd.0 as isize));
}

/// What the cursor thread needs to know.
#[derive(Clone, Default)]
struct CursorCtl {
    on: bool,
    low_power: bool,
    interactive: bool,
    frame: util::Frame,
}

// Field order matters: the web view is dropped before its window.
struct SettingsWin {
    web: WebView,
    window: Window,
}

struct App {
    s: Settings,
    overlay: Window,
    web: WebView,
    hwnd: HWND,
    settings_win: Option<SettingsWin>,
    tray: Option<TrayIcon>,
    context: WebContext,
    proxy: EventLoopProxy<UserEvent>,
    ready: bool,
    interactive: bool,
    perched: bool,
    shown_now: bool,
    acts: Vec<String>,
    last_act: String,
    energy: f64,
    mood: f64,
    full: f64,
    auto_hidden: Option<&'static str>,
    clear_since: Option<Instant>,
    pause_reasons: HashSet<&'static str>,
    last_low_power: Option<bool>,
    frame: util::Frame,
    world: Arc<Mutex<world::Control>>,
    senses: Arc<Mutex<senses::Control>>,
    cursor: Arc<Mutex<CursorCtl>>,
    menu_key: String,
}

fn tricks() -> Vec<(&'static str, &'static str)> {
    vec![
        ("climb", "Залезть на окно 🪟"), ("icons", "По иконкам 📁"), ("dock", "На панель задач"),
        ("jetpack", "Джетпак 🚀"), ("balloon", "Шарик 🎈"), ("wall", "По стене"), ("cartwheel", "Колесо"),
        ("moonwalk", "Лунная походка"), ("dance", "Танец"), ("juggle", "Жонглировать"), ("ball", "Мячик ⚽"),
        ("plane", "Самолётик"), ("giant", "Великан"), ("tiny", "Малыш"), ("dig", "Закопаться"), ("pogo", "Попрыгать"),
        ("wrap", "Убежать за край"), ("gear", "Переодеться"), ("head", "Потерять голову"), ("nap", "Поспать"),
        ("flip", "Сальто"), ("wave", "Помахать"), ("chase", "Поймать курсор"), ("treat", "Угостить печенькой 🍪"),
        ("knock", "Постучать в экран 👀"), ("jacks", "Зарядка 💪"), ("think", "Задуматься 🤔"),
        ("butterfly", "Бабочка 🦋"), ("bubbles", "Мыльные пузыри 🫧"), ("kungfu", "Кунг-фу 🥋"), ("peekaboo", "Ку-ку"),
        ("skate", "Покататься ⛸"), ("weather", "Погода за окном ❄️"),
        ("magic", "Фокус с кроликом 🎩"), ("glitch", "Сломаться (понарошку) 👾"), ("selfie", "Селфи 📸"),
        ("breakdance", "Брейк-данс"), ("disco", "Дискотека 🪩"), ("drum", "Барабаны 🥁"), ("spy", "Шпион 🕵️"),
        ("teleport", "Телепорт ✨"), ("meditate", "Медитация 🧘"), ("hiccup", "Икота"),
        ("kite", "Воздушный змей 🪁"), ("raindance", "Танец дождя ☂️"), ("fishing", "Рыбалка 🎣"), ("guitar", "Гитара 🎸"),
        ("ghost", "Привидение 👻"), ("photo", "Сфоткать курсор 📷"), ("build", "Построить по сезону ⛄"),
        ("bubblegum", "Жвачка"), ("coffee", "Кофе и зумис ☕"), ("banana", "Банановая кожура 🍌"), ("sleepwalk", "Лунатик"),
    ]
}

fn serve(path: &str) -> (Cow<'static, [u8]>, &'static str) {
    match path.trim_start_matches('/') {
        "overlay.html" => (Cow::Borrowed(OVERLAY_HTML.as_bytes()), "text/html; charset=utf-8"),
        "bridge.js" => (Cow::Borrowed(BRIDGE_JS.as_bytes()), "text/javascript; charset=utf-8"),
        "akko.global.js" => (Cow::Borrowed(AKKO_JS.as_bytes()), "text/javascript; charset=utf-8"),
        "settings.html" => (Cow::Borrowed(SETTINGS_HTML.as_bytes()), "text/html; charset=utf-8"),
        "icon.png" => (Cow::Borrowed(ICON_PNG), "image/png"),
        _ => (Cow::Borrowed(b"" as &[u8]), "text/plain"),
    }
}

fn protocol(_: wry::WebViewId, req: wry::http::Request<Vec<u8>>) -> wry::http::Response<Cow<'static, [u8]>> {
    let (body, mime) = serve(req.uri().path());
    let status = if body.is_empty() { 404 } else { 200 };
    wry::http::Response::builder().status(status).header("Content-Type", mime).body(body).unwrap()
}

/// Keep WebView2 lean: no background networking, no updater, no translate or spell check, small JS heap.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,Translate,SpellCheck,AutofillServerCommunication --disable-background-networking --disable-component-update --disable-sync --no-first-run --js-flags=--max-old-space-size=96";

fn pick_monitor(target: &EventLoopWindowTarget<UserEvent>, name: &Option<String>) -> Option<MonitorHandle> {
    if let Some(n) = name {
        if let Some(m) = target.available_monitors().find(|m| m.name().as_deref() == Some(n.as_str())) {
            return Some(m);
        }
    }
    target.primary_monitor().or_else(|| target.available_monitors().next())
}

/// The whole monitor, one pixel short: a topmost window covering all of it would count as a full-screen app
/// for Windows (the taskbar would step back and notifications would go quiet).
fn area(m: &MonitorHandle) -> util::Rect {
    let p = m.position();
    let s = m.size();
    util::Rect { x: p.x, y: p.y + 1, w: s.width as i32, h: s.height as i32 - 1 }
}

impl App {
    fn js(&self, code: &str) {
        if self.ready {
            let _ = self.web.evaluate_script(code);
        }
    }

    fn system_paused(&self) -> bool { !self.pause_reasons.is_empty() }
    fn shown(&self) -> bool { self.s.visible && self.auto_hidden.is_none() }
    fn running(&self) -> bool { self.shown() && !self.s.paused && !self.system_paused() }

    fn low_power(&self) -> bool {
        match self.s.power.as_str() {
            "on" => true,
            "off" => false,
            _ => senses::on_battery_or_saver(),
        }
    }

    fn status_text(&self) -> &'static str {
        if !self.s.visible {
            return "Спрятан";
        }
        match self.auto_hidden {
            Some("video") => return "Прячется: видео",
            Some("fullscreen") => return "Прячется: полный экран",
            Some("capture") => return "Прячется: запись экрана",
            _ => {}
        }
        if self.system_paused() {
            return "Спит";
        }
        if self.s.paused {
            return "На паузе";
        }
        "Гуляет"
    }

    fn energy_text(&self) -> &'static str { if self.energy < 0.3 { "устал 🥱" } else if self.energy > 0.7 { "бодрый ⚡" } else { "в норме" } }
    fn mood_text(&self) -> &'static str { if self.mood < 0.35 { "грустит 😔" } else if self.mood > 0.75 { "счастлив 😊" } else { "спокоен 🙂" } }
    fn full_text(&self) -> &'static str {
        if self.full < 0.2 { "голодный 😋" } else if self.full < 0.6 { "перекусил бы" } else if self.full < 0.95 { "сытый" } else { "наелся 🫃" }
    }

    fn act_list(&self) -> Vec<(&'static str, &'static str)> {
        tricks().into_iter().filter(|(n, _)| self.acts.is_empty() || self.acts.iter().any(|a| a == n)).collect()
    }

    fn play(&self, name: Option<&str>) {
        let list = self.act_list();
        let n = match name {
            Some(n) => n.to_string(),
            None => {
                if list.is_empty() {
                    return;
                }
                let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos() as usize).unwrap_or(0);
                list[t % list.len()].0.to_string()
            }
        };
        if n.chars().all(|c| c.is_ascii_alphanumeric()) {
            self.js(&format!("desk.play('{n}')"));
        }
    }

    fn feed(&self) { self.js("desk.feed()"); }

    /// Push everything to the window, the page, the threads, the tray and the settings window. Cheap; called on any change.
    fn apply(&mut self) {
        let shown = self.shown();
        if shown != self.shown_now {
            self.shown_now = shown;
            self.overlay.set_visible(shown);
            if shown {
                self.raise();
            }
        }
        let running = self.running();
        if !running && self.interactive {
            self.interactive = false;
            let _ = self.overlay.set_ignore_cursor_events(true);
        }
        let lp = self.low_power();
        self.last_low_power = Some(lp);
        let act = [0.5, 1.0, 1.8][self.s.activity.clamp(0, 2) as usize];
        let traits = format!(
            "{{activity:{act},chatty:{},breaks:{},nightSleep:{},follow:{}}}",
            self.s.chatty.clamp(0, 2), self.s.breaks, self.s.night_sleep, self.s.follow
        );
        self.js(&format!(
            "desk.state({{size:{},lowPower:{lp},running:{running},lang:'{}',traits:{traits}}})",
            self.s.size, if self.s.lang == "ru" { "ru" } else { "en" }
        ));
        // A paused or hidden page gets its memory trimmed.
        let _ = self.web.set_memory_usage_level(if running { wry::MemoryUsageLevel::Normal } else { wry::MemoryUsageLevel::Low });
        {
            let mut c = self.cursor.lock().unwrap();
            c.on = running && self.ready;
            c.low_power = lp;
            c.interactive = self.interactive;
            c.frame = self.frame;
        }
        self.watch_world();
        {
            let mut c = self.senses.lock().unwrap();
            c.watch = self.s.visible && (self.s.hide_video || self.s.hide_full_screen || self.s.hide_capture);
            c.senses = self.ready && running && self.s.senses;
            c.frame = self.frame;
        }
        // Switching a reason off brings him back right away instead of after the next quiet spell.
        let stale = matches!(
            (self.auto_hidden, self.s.hide_video, self.s.hide_full_screen, self.s.hide_capture),
            (Some("video"), false, _, _) | (Some("fullscreen"), _, false, _) | (Some("capture"), _, _, false)
        );
        if self.auto_hidden.is_some() && (!self.s.visible || stale) {
            self.auto_hidden = None;
            self.clear_since = None;
            return self.apply();
        }
        self.update_tray();
        self.push_ui();
    }

    fn watch_world(&mut self) {
        let every = if !(self.ready && self.running() && self.s.climb) {
            0
        } else if self.perched {
            100
        } else if self.last_low_power == Some(true) {
            2000
        } else {
            1000
        };
        let mut c = self.world.lock().unwrap();
        if every == 0 && c.every_ms != 0 {
            drop(c);
            self.js("desk.world(null)");
            c = self.world.lock().unwrap();
        }
        c.every_ms = every;
        c.frame = self.frame;
    }

    /// Stay above other topmost windows (the taskbar raises itself when clicked).
    fn raise(&self) {
        unsafe {
            let _ = SetWindowPos(self.hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }

    fn fit(&mut self, target: &EventLoopWindowTarget<UserEvent>) {
        let Some(m) = pick_monitor(target, &self.s.screen) else { return };
        let a = area(&m);
        self.overlay.set_outer_position(PhysicalPosition::new(a.x, a.y));
        self.overlay.set_inner_size(PhysicalSize::new(a.w as u32, a.h as u32));
        self.frame = util::Frame { r: a, scale: m.scale_factor() };
        self.world.lock().unwrap().resend = true;
        self.apply();
    }

    fn check_auto_hide(&mut self, sig: senses::Signals) {
        if !self.s.visible || self.system_paused() {
            return;
        }
        // Recording or sharing the screen decides on its own: hide from it, or stay out for the demo even
        // though a share in a call also looks like a call.
        let why = if sig.capture {
            if self.s.hide_capture { Some("capture") } else { None }
        } else if self.s.hide_video && sig.video {
            Some("video")
        } else if self.s.hide_full_screen && sig.fullscreen {
            Some("fullscreen")
        } else {
            None
        };
        if let Some(w) = why {
            self.clear_since = None;
            if self.auto_hidden != Some(w) {
                self.auto_hidden = Some(w);
                self.apply();
            }
        } else if self.auto_hidden.is_some() {
            // Come back only after a few quiet seconds: players drop and re-take their media session.
            let since = *self.clear_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_secs(6) {
                self.auto_hidden = None;
                self.clear_since = None;
                self.apply();
            }
        }
    }

    fn foreground(&self, hwnd: isize) {
        if !(self.ready && self.running() && self.s.senses) {
            return;
        }
        let h = HWND(hwnd as *mut _);
        let pid = util::pid_of(h);
        if pid == std::process::id() || pid == 0 {
            return;
        }
        let exe = util::exe_of(pid);
        let mut e = serde_json::json!({"t": "app", "c": util::kind(&exe)});
        if let Some(r) = util::visible_rect(h) {
            let p = self.frame.page(&r);
            if r.w >= 100 && r.h >= 50 && p.intersects(&self.frame.page_bounds()) {
                e["id"] = (hwnd as i64).into();
                e["x"] = p.x.into();
                e["y"] = p.y.into();
                e["w"] = p.w.into();
                e["h"] = p.h.into();
            }
        }
        self.js(&format!("desk.sense({e})"));
    }

    // MARK: Messages from the page

    fn overlay_message(&mut self, body: &str) {
        let Ok(m) = serde_json::from_str::<serde_json::Value>(body) else { return };
        match m["t"].as_str().unwrap_or("") {
            "ready" => {
                self.ready = true;
                self.acts = m["acts"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
                self.last_low_power = None;
                self.world.lock().unwrap().resend = true;
                self.apply();
            }
            "interactive" => {
                let on = m["on"].as_bool().unwrap_or(false);
                if on != self.interactive {
                    self.interactive = on;
                    let _ = self.overlay.set_ignore_cursor_events(!on);
                    self.cursor.lock().unwrap().interactive = on;
                }
            }
            "perch" => {
                self.perched = m["on"].as_bool().unwrap_or(false);
                self.watch_world();
            }
            "mood" => {
                self.energy = m["e"].as_f64().unwrap_or(self.energy);
                self.mood = m["m"].as_f64().unwrap_or(self.mood);
                self.full = m["f"].as_f64().unwrap_or(self.full);
                self.push_ui();
            }
            "act" => {
                self.last_act = m["n"].as_str().unwrap_or("").to_string();
                self.update_tray();
            }
            _ => {}
        }
    }

    // MARK: Settings window

    fn ui_state(&self) -> String {
        let acts: Vec<serde_json::Value> = self.act_list().iter().map(|(n, l)| serde_json::json!([n, l])).collect();
        let mut v = serde_json::to_value(&self.s).unwrap_or_default();
        v["status"] = self.status_text().into();
        v["running"] = self.running().into();
        v["energy"] = self.energy.into();
        v["mood"] = self.mood.into();
        v["full"] = self.full.into();
        v["energyText"] = self.energy_text().into();
        v["moodText"] = self.mood_text().into();
        v["fullText"] = self.full_text().into();
        v["login"] = launch_at_login().into();
        v["acts"] = acts.into();
        v["hotkey"] = HOTKEY.into();
        v.to_string()
    }

    fn push_ui(&self) {
        if let Some(sw) = &self.settings_win {
            let _ = sw.web.evaluate_script(&format!("window.ui && ui.state({})", self.ui_state()));
        }
    }

    fn show_settings(&mut self, target: &EventLoopWindowTarget<UserEvent>) {
        if let Some(sw) = &self.settings_win {
            sw.window.set_visible(true);
            sw.window.set_minimized(false);
            sw.window.set_focus();
            return;
        }
        let dark = senses::dark_mode();
        let icon = WindowIcon::from_rgba(ICON64.to_vec(), 64, 64).ok();
        let Ok(window) = WindowBuilder::new()
            .with_title("Акко")
            .with_inner_size(LogicalSize::new(380.0, 470.0))
            .with_resizable(false)
            .with_maximizable(false)
            .with_window_icon(icon)
            .with_theme(Some(if dark { tao::window::Theme::Dark } else { tao::window::Theme::Light }))
            .with_visible(false)
            .build(target)
        else {
            return;
        };
        // Centre on the monitor he walks on.
        if let Some(m) = pick_monitor(target, &self.s.screen) {
            let ms = m.size();
            let ws = window.outer_size();
            let p = m.position();
            window.set_outer_position(PhysicalPosition::new(p.x + (ms.width as i32 - ws.width as i32) / 2, p.y + (ms.height as i32 - ws.height as i32) / 3));
        }
        let proxy = self.proxy.clone();
        let bg = if dark { (32, 32, 32, 255) } else { (243, 243, 243, 255) };
        let web = WebViewBuilder::new_with_web_context(&mut self.context)
            .with_custom_protocol("akko".into(), protocol)
            .with_url("http://akko.localhost/settings.html")
            .with_background_color(bg)
            .with_devtools(false)
            .with_default_context_menus(false)
            .with_browser_accelerator_keys(false)
            .with_additional_browser_args(BROWSER_ARGS)
            .with_ipc_handler(move |req| { let _ = proxy.send_event(UserEvent::SettingsIpc(req.body().clone())); })
            .build(&window);
        let Ok(web) = web else { return };
        window.set_visible(true);
        window.set_focus();
        self.settings_win = Some(SettingsWin { web, window });
    }

    fn settings_message(&mut self, body: &str, target: &EventLoopWindowTarget<UserEvent>, flow: &mut ControlFlow) {
        let Ok(m) = serde_json::from_str::<serde_json::Value>(body) else { return };
        match m["t"].as_str().unwrap_or("") {
            "ready" => self.push_ui(),
            "set" => {
                let k = m["k"].as_str().unwrap_or("");
                self.s.set(k, &m["v"]);
                self.s.save();
                self.apply();
            }
            "play" => self.play(m["n"].as_str()),
            "feed" => self.feed(),
            "login" => {
                set_launch_at_login(m["v"].as_bool().unwrap_or(false));
                self.push_ui();
            }
            "height" => {
                if let (Some(sw), Some(h)) = (&self.settings_win, m["h"].as_f64()) {
                    sw.window.set_inner_size(LogicalSize::new(380.0, h.clamp(200.0, 900.0)));
                }
            }
            "quit" => *flow = ControlFlow::Exit,
            _ => {}
        }
        let _ = target;
    }

    // MARK: Tray

    fn update_tray(&mut self) {
        let key = format!("{}|{}|{}|{}|{}|{}|{}|{}|{}", self.status_text(), self.s.visible, self.s.paused, self.s.size, self.s.power, self.running(), self.last_act, launch_at_login(), self.acts.len());
        if let Some(t) = &self.tray {
            let _ = t.set_visible(self.s.menu_icon);
        }
        if key == self.menu_key || self.tray.is_none() {
            return;
        }
        self.menu_key = key;
        let menu = self.build_menu();
        if let Some(t) = &self.tray {
            t.set_menu(Some(Box::new(menu)));
        }
    }

    fn build_menu(&self) -> Menu {
        let s = &self.s;
        let menu = Menu::new();
        let _ = menu.append(&MenuItem::with_id("status", format!("Акко — {}", self.status_text().to_lowercase()), false, None));
        let _ = menu.append(&PredefinedMenuItem::separator());
        let _ = menu.append(&MenuItem::with_id("settings", "Настройки…", true, None));
        let _ = menu.append(&MenuItem::with_id("toggle", format!("{}\t{HOTKEY}", if s.visible { "Спрятать" } else { "Показать" }), true, None));
        let _ = menu.append(&CheckMenuItem::with_id("pause", "Пауза", s.visible, s.paused, None));
        let tricks_menu = Submenu::with_id("tricks", "Сделать трюк", self.running());
        let _ = tricks_menu.append(&MenuItem::with_id("trick:", "Случайный", true, None));
        let _ = tricks_menu.append(&PredefinedMenuItem::separator());
        for (n, l) in self.act_list() {
            let _ = tricks_menu.append(&MenuItem::with_id(format!("trick:{n}"), l, true, None));
        }
        let _ = menu.append(&tricks_menu);
        let _ = menu.append(&MenuItem::with_id("feed", "Бросить еду 🍪", self.running(), None));
        let _ = menu.append(&PredefinedMenuItem::separator());
        let sizes = Submenu::with_id("sizes", "Размер", true);
        for (v, l) in [(32, "Маленький"), (44, "Обычный"), (60, "Большой"), (84, "Огромный")] {
            let _ = sizes.append(&CheckMenuItem::with_id(format!("size:{v}"), l, true, s.size == v, None));
        }
        let _ = menu.append(&sizes);
        let power = Submenu::with_id("powers", "Экономия энергии", true);
        for (v, l) in [("auto", "Авто (на батарее)"), ("on", "Всегда"), ("off", "Выключена")] {
            let _ = power.append(&CheckMenuItem::with_id(format!("power:{v}"), l, true, s.power == v, None));
        }
        let _ = menu.append(&power);
        let _ = menu.append(&CheckMenuItem::with_id("login", "Запускать при входе", true, launch_at_login(), None));
        let _ = menu.append(&PredefinedMenuItem::separator());
        if !self.last_act.is_empty() && self.running() {
            let label = tricks().into_iter().find(|(n, _)| *n == self.last_act).map(|(_, l)| l.to_string()).unwrap_or_else(|| self.last_act.clone());
            let _ = menu.append(&MenuItem::with_id("now", format!("Сейчас: {label}"), false, None));
        }
        let _ = menu.append(&MenuItem::with_id("quit", "Выйти", true, None));
        menu
    }

    fn menu_event(&mut self, id: &str, target: &EventLoopWindowTarget<UserEvent>, flow: &mut ControlFlow) {
        match id {
            "settings" => self.show_settings(target),
            "toggle" => self.toggle_visible(),
            "pause" => {
                self.s.paused = !self.s.paused;
                self.s.save();
                self.apply();
            }
            "feed" => self.feed(),
            "login" => {
                set_launch_at_login(!launch_at_login());
                self.menu_key.clear();
                self.apply();
            }
            "quit" => *flow = ControlFlow::Exit,
            _ => {
                if let Some(n) = id.strip_prefix("trick:") {
                    self.play(if n.is_empty() { None } else { Some(n) });
                } else if let Some(v) = id.strip_prefix("size:") {
                    self.s.size = v.parse().unwrap_or(44);
                    self.s.save();
                    self.apply();
                } else if let Some(v) = id.strip_prefix("power:") {
                    self.s.power = v.into();
                    self.s.save();
                    self.apply();
                }
            }
        }
        // Check items flip themselves when clicked: rebuild so they show the real state.
        self.menu_key.clear();
        self.update_tray();
    }

    fn pause_reason(&mut self, why: &'static str, on: bool) {
        let changed = if on { self.pause_reasons.insert(why) } else { self.pause_reasons.remove(why) };
        if changed {
            self.apply();
        }
    }

    fn toggle_visible(&mut self) {
        self.s.visible = !self.s.visible;
        self.s.save();
        self.apply();
    }
}

// MARK: Launch at login (the per-user Run key)

const RUN_KEY: windows::core::PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");

fn launch_at_login() -> bool {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_SZ, RegGetValueW};
    unsafe { RegGetValueW(HKEY_CURRENT_USER, RUN_KEY, w!("Akko"), RRF_RT_REG_SZ, None, None, None).is_ok() }
}

fn set_launch_at_login(on: bool) {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, REG_SZ, RegDeleteKeyValueW, RegSetKeyValueW};
    unsafe {
        if on {
            let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
            let v: Vec<u16> = format!("\"{exe}\"").encode_utf16().chain(std::iter::once(0)).collect();
            let _ = RegSetKeyValueW(HKEY_CURRENT_USER, RUN_KEY, w!("Akko"), REG_SZ.0, Some(v.as_ptr() as *const _), (v.len() * 2) as u32);
        } else {
            let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN_KEY, w!("Akko"));
        }
    }
}

/// The cursor, for his eyes and for grabbing him: the window lets clicks through, so it is polled — 30 times a
/// second while it moves (15 when saving power), a few times a second while it rests.
fn spawn_cursor(ctl: Arc<Mutex<CursorCtl>>, proxy: EventLoopProxy<UserEvent>) {
    std::thread::spawn(move || {
        let mut last = (i32::MIN, i32::MIN);
        let mut moved = Instant::now();
        loop {
            let c = ctl.lock().unwrap().clone();
            if !c.on {
                last = (i32::MIN, i32::MIN);
                std::thread::sleep(Duration::from_millis(250));
                continue;
            }
            let mut pt = POINT::default();
            unsafe { let _ = GetCursorPos(&mut pt); }
            let s = if c.frame.scale > 0.0 { c.frame.scale } else { 1.0 };
            let p = (((pt.x - c.frame.r.x) as f64 / s).round() as i32, ((pt.y - c.frame.r.y) as f64 / s).round() as i32);
            if p != last {
                last = p;
                moved = Instant::now();
                let _ = proxy.send_event(UserEvent::Cursor(p.0, p.1));
            }
            let active = c.interactive || moved.elapsed() < Duration::from_millis(400);
            let ms = if !active { 150 } else if c.low_power { 66 } else { 33 };
            std::thread::sleep(Duration::from_millis(ms));
        }
    });
}

fn main() {
    // One Akko at a time: launching him again opens the settings of the one already running.
    unsafe {
        let _ = CreateMutexW(None, true, &HSTRING::from("Local\\AkkoSingleInstance"));
        if GetLastError() == ERROR_ALREADY_EXISTS {
            if let Ok(h) = FindWindowW(None, &HSTRING::from(OVERLAY_TITLE)) {
                let _ = PostMessageW(Some(h), WM_SHOW_SETTINGS, WPARAM(0), LPARAM(0));
            }
            return;
        }
    }

    let event_loop: EventLoop<UserEvent> = EventLoopBuilder::with_user_event().build();
    // No raw input: the cursor is polled, typing is noticed without a keyboard hook.
    event_loop.set_device_event_filter(DeviceEventFilter::Always);
    let proxy = event_loop.create_proxy();
    let _ = PROXY.set(Mutex::new(proxy.clone()));

    let mut s = Settings::load();
    let monitor = pick_monitor(&event_loop, &s.screen).expect("no monitor");
    let a = area(&monitor);

    let overlay = WindowBuilder::new()
        .with_title(OVERLAY_TITLE)
        .with_decorations(false)
        .with_transparent(true)
        .with_always_on_top(true)
        .with_skip_taskbar(true)
        .with_undecorated_shadow(false)
        .with_resizable(false)
        .with_focused(false)
        .with_visible(false)
        .with_position(PhysicalPosition::new(a.x, a.y))
        .with_inner_size(PhysicalSize::new(a.w as u32, a.h as u32))
        .build(&event_loop)
        .expect("overlay window");
    let hwnd = HWND(overlay.hwnd() as *mut _);
    unsafe {
        // Never activated, never in Alt+Tab.
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize);
        let old = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, overlay_proc as *const () as usize as isize);
        OLD_PROC.store(old, Ordering::Relaxed);
        let _ = RegisterHotKey(Some(hwnd), 1, MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT, 'M' as u32);
        let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        let _ = RegisterPowerSettingNotification(windows::Win32::Foundation::HANDLE(hwnd.0), &GUID_CONSOLE_DISPLAY_STATE, DEVICE_NOTIFY_WINDOW_HANDLE);
        SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(foreground_hook), 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    }
    let _ = overlay.set_ignore_cursor_events(true);

    // The web engine's cache lives in the local (not roaming) profile.
    let data = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).unwrap_or_else(settings::dir).join("Akko").join("WebView2");
    let mut context = WebContext::new(Some(data));
    let p = proxy.clone();
    let web = WebViewBuilder::new_with_web_context(&mut context)
        .with_custom_protocol("akko".into(), protocol)
        .with_url("http://akko.localhost/overlay.html")
        .with_transparent(true)
        .with_background_color((0, 0, 0, 0))
        .with_devtools(false)
        .with_focused(false)
        .with_default_context_menus(false)
        .with_browser_accelerator_keys(false)
        .with_additional_browser_args(BROWSER_ARGS)
        .with_ipc_handler(move |req| { let _ = p.send_event(UserEvent::OverlayIpc(req.body().clone())); })
        .build(&overlay)
        .expect("WebView2");

    TrayIconEvent::set_event_handler(Some({
        let p = proxy.clone();
        move |e| { let _ = p.send_event(UserEvent::Tray(e)); }
    }));
    MenuEvent::set_event_handler(Some({
        let p = proxy.clone();
        move |e| { let _ = p.send_event(UserEvent::Menu(e)); }
    }));
    let tray = tray_icon::Icon::from_rgba(ICON32.to_vec(), 32, 32)
        .ok()
        .and_then(|icon| TrayIconBuilder::new().with_icon(icon).with_tooltip("Акко").with_menu_on_left_click(false).build().ok());

    let frame = util::Frame { r: a, scale: monitor.scale_factor() };
    let world_ctl = Arc::new(Mutex::new(world::Control { frame, ..Default::default() }));
    let senses_ctl = Arc::new(Mutex::new(senses::Control { frame, ..Default::default() }));
    let cursor_ctl = Arc::new(Mutex::new(CursorCtl { frame, ..Default::default() }));
    {
        let p = proxy.clone();
        world::spawn(world_ctl.clone(), move |o| {
            let _ = p.send_event(match o {
                world::Out::World(j) => UserEvent::World(j),
                world::Out::Sense(j) => UserEvent::Sense(j),
            });
        });
        let p = proxy.clone();
        senses::spawn(senses_ctl.clone(), move |o| {
            let _ = p.send_event(match o {
                senses::Out::Sense(j) => UserEvent::Sense(j),
                senses::Out::Signals(sig) => UserEvent::Signals(sig),
                senses::Out::Power => UserEvent::Power,
            });
        });
        spawn_cursor(cursor_ctl.clone(), proxy.clone());
    }

    let first_run = !s.welcomed;
    if first_run {
        s.welcomed = true;
        s.save();
    }
    let mut app = App {
        s,
        overlay,
        web,
        hwnd,
        settings_win: None,
        tray,
        context,
        proxy,
        ready: false,
        interactive: false,
        perched: false,
        shown_now: false,
        acts: Vec::new(),
        last_act: String::new(),
        energy: 0.8,
        mood: 0.65,
        full: 0.5,
        auto_hidden: None,
        clear_since: None,
        pause_reasons: HashSet::new(),
        last_low_power: None,
        frame,
        world: world_ctl,
        senses: senses_ctl,
        cursor: cursor_ctl,
        menu_key: String::new(),
    };

    let mut raised = Instant::now();
    event_loop.run(move |event, target, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {
                app.apply();
                if first_run {
                    app.show_settings(target);
                }
            }
            Event::WindowEvent { window_id, event: WindowEvent::CloseRequested, .. } => {
                // Closing the settings window frees its web view (it is rebuilt in a moment when opened again).
                if app.settings_win.as_ref().is_some_and(|sw| sw.window.id() == window_id) {
                    app.settings_win = None;
                }
            }
            Event::WindowEvent { window_id, event: WindowEvent::ScaleFactorChanged { .. }, .. } if window_id == app.overlay.id() => app.fit(target),
            Event::UserEvent(e) => match e {
                UserEvent::OverlayIpc(b) => app.overlay_message(&b),
                UserEvent::SettingsIpc(b) => app.settings_message(&b, target, flow),
                UserEvent::Cursor(x, y) => app.js(&format!("desk.cursor({x},{y})")),
                UserEvent::World(j) => {
                    app.js(&format!("desk.world({j})"));
                    if raised.elapsed() > Duration::from_secs(2) && app.shown_now {
                        app.raise();
                        raised = Instant::now();
                    }
                }
                UserEvent::Sense(j) => {
                    if app.s.senses && app.running() {
                        app.js(&format!("desk.sense({j})"));
                    }
                }
                UserEvent::Signals(sig) => app.check_auto_hide(sig),
                UserEvent::Power => {
                    if app.low_power() != app.last_low_power.unwrap_or(false) || app.last_low_power.is_none() {
                        app.apply();
                    }
                }
                UserEvent::Foreground(h) => app.foreground(h),
                UserEvent::Sys(sys) => match sys {
                    Sys::Hotkey => app.toggle_visible(),
                    Sys::ShowSettings => app.show_settings(target),
                    Sys::DisplayChange => app.fit(target),
                    Sys::Power => {
                        if Some(app.low_power()) != app.last_low_power {
                            app.apply();
                        }
                    }
                    // Why the system put him to sleep; he runs only when there is no reason left.
                    // (The display wakes on the lock screen before you unlock it.)
                    Sys::Lock(on) => app.pause_reason("lock", on),
                    Sys::Suspend(on) => app.pause_reason("sleep", on),
                    Sys::Display(on) => app.pause_reason("display", !on),
                },
                UserEvent::Tray(t) => {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = t {
                        app.show_settings(target);
                    }
                }
                UserEvent::Menu(m) => {
                    let id = m.id().0.clone();
                    app.menu_event(&id, target, flow);
                }
            },
            _ => {}
        }
        let _: Option<WindowId> = None;
    });
}
