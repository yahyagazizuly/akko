// What the desktop looks like to him: the taskbar, the windows (front to back) and the desktop icons, as
// rectangles in the overlay's page coordinates. Sent to the page only when something changed.
// Also notices new windows, notification toasts, the screenshot tool, and apps opening and closing.
//
// Everything here is public window information: no permission is needed. The visible frame comes from DWM
// (without the invisible resize border and the shadow), which is what the Mac app needed its "eyes" for.

use crate::util::{self, Frame, Rect};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows::Win32::System::Com::{CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree, IServiceProvider};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Shell::{
    FOLDERVIEWMODE, IFolderView, IFolderView2, IShellBrowser, IShellWindows, SID_STopLevelBrowser, SVGIO_ALLVIEW,
    SWC_DESKTOP, SWFO_NEEDDISPATCH, ShellWindows,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, FindWindowW, GW_OWNER, GWL_EXSTYLE, GetClassNameW, GetWindow, GetWindowLongW,
    GetWindowTextLengthW, IsIconic, IsWindowVisible, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::core::{BOOL, Interface, w};

/// What the main thread tells the looker: where the overlay is, how often to look, whether to look at all.
#[derive(Clone, Default)]
pub struct Control {
    pub frame: Frame,
    /// 0 = stopped.
    pub every_ms: u64,
    pub resend: bool,
}

pub enum Out {
    /// {"b":[[id, kind, x, y, w, h, on], ...], "a": {"id": "kind"}} for desk.world()
    World(String),
    /// An event for desk.sense()
    Sense(String),
}

pub fn spawn(ctl: Arc<Mutex<Control>>, send: impl Fn(Out) + Send + 'static) {
    std::thread::spawn(move || {
        unsafe { let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED); }
        let mut w = World::default();
        loop {
            let c = ctl.lock().unwrap().clone();
            if c.every_ms == 0 {
                w.last.clear();
                w.last_ids = None;
                std::thread::sleep(Duration::from_millis(250));
                continue;
            }
            if c.resend {
                w.last.clear();
                ctl.lock().unwrap().resend = false;
            }
            let (json, news) = w.look(&c.frame);
            if json != w.last {
                w.last = json.clone();
                send(Out::World(json));
            }
            for n in news {
                send(Out::Sense(n));
            }
            std::thread::sleep(Duration::from_millis(c.every_ms));
        }
    });
}

#[derive(Default)]
struct World {
    last: String,
    last_ids: Option<HashSet<isize>>,
    exes: HashMap<u32, String>,
    icons: Vec<Rect>,
    icons_at: Option<Instant>,
    started: Option<Instant>,
    /// Apps with windows on the last look, by process: to notice apps opening and closing.
    apps: HashMap<u32, String>,
}

struct Win {
    hwnd: HWND,
    rect: Rect,
    pid: u32,
    class: String,
}

unsafe extern "system" fn collect(hwnd: HWND, lp: LPARAM) -> BOOL {
    let list = unsafe { &mut *(lp.0 as *mut Vec<HWND>) };
    list.push(hwnd);
    BOOL(1)
}

fn class_of(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

impl World {
    fn exe(&mut self, pid: u32) -> String {
        if let Some(e) = self.exes.get(&pid) {
            return e.clone();
        }
        let e = util::exe_of(pid);
        if self.exes.len() > 300 {
            self.exes.clear();
        }
        self.exes.insert(pid, e.clone());
        e
    }

    fn look(&mut self, f: &Frame) -> (String, Vec<String>) {
        let started = *self.started.get_or_insert_with(Instant::now);
        let me = std::process::id();
        let mut hwnds: Vec<HWND> = Vec::with_capacity(256);
        unsafe { let _ = EnumWindows(Some(collect), LPARAM(&mut hwnds as *mut _ as isize)); }

        let bounds = f.page_bounds();
        let screen = f.r;
        let mut out: Vec<[i64; 7]> = Vec::new();
        let mut apps_json = serde_json::Map::new();
        let mut news: Vec<serde_json::Value> = Vec::new();
        let mut ids = HashSet::new();
        let mut now_apps: HashMap<u32, String> = HashMap::new();
        let fresh = |ids: &Option<HashSet<isize>>, id: isize| ids.as_ref().is_some_and(|s| !s.contains(&id));
        let mut wins: Vec<Win> = Vec::new();

        for hwnd in hwnds {
            unsafe {
                if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() || util::cloaked(hwnd) {
                    continue;
                }
            }
            let pid = util::pid_of(hwnd);
            if pid == me {
                continue;
            }
            let Some(rect) = util::visible_rect(hwnd) else { continue };
            if rect.w < 60 || rect.h < 30 {
                continue;
            }
            let class = class_of(hwnd);
            wins.push(Win { hwnd, rect, pid, class });
        }

        // A window filling the whole screen (a game, a video, a presentation) hides the taskbar behind it.
        let covered = wins.first().is_some_and(|w| w.rect.x <= screen.x && w.rect.y <= screen.y && w.rect.right() >= screen.right() && w.rect.bottom() >= screen.bottom() - 1);

        for w in &wins {
            let id = w.hwnd.0 as isize;
            ids.insert(id);
            let exe = self.exe(w.pid);
            let p = f.page(&w.rect);
            // A notification toast, or the screenshot tool, just showed up.
            if fresh(&self.last_ids, id) {
                if exe == "shellexperiencehost.exe" && (250..=700).contains(&p.w) && (40..=400).contains(&p.h) && p.intersects(&bounds) {
                    news.push(serde_json::json!({"t": "notify", "x": p.x, "y": p.y, "w": p.w, "h": p.h}));
                }
                if exe == "screenclippinghost.exe" || exe == "snippingtool.exe" {
                    news.push(serde_json::json!({"t": "shot"}));
                }
            }
            // Only normal app windows from here: no system surfaces, tool palettes or invisible helpers.
            if matches!(w.class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Windows.UI.Core.CoreWindow" | "XamlExplorerHostIslandWindow" | "TopLevelWindowForOverflowXamlIsland" | "NotifyIconOverflowWindow") {
                continue;
            }
            let ex = unsafe { GetWindowLongW(w.hwnd, GWL_EXSTYLE) } as u32;
            if ex & WS_EX_TOOLWINDOW.0 != 0 || ex & WS_EX_NOACTIVATE.0 != 0 {
                continue;
            }
            if unsafe { GetWindowTextLengthW(w.hwnd) } == 0 && unsafe { GetWindow(w.hwnd, GW_OWNER) }.is_err() {
                continue;
            }
            if w.rect.w < 100 || w.rect.h < 50 {
                continue;
            }
            let k = util::kind(&exe);
            now_apps.insert(w.pid, exe.clone());
            if out.len() >= 40 || !p.intersects(&bounds) {
                continue;
            }
            apps_json.insert(id.to_string(), k.into());
            // A new, real window (not a little panel) opened.
            if fresh(&self.last_ids, id) && p.w >= 300 && p.h >= 200 {
                news.push(serde_json::json!({"t": "window", "c": k, "id": id, "x": p.x, "y": p.y, "w": p.w, "h": p.h}));
            }
            out.push([id as i64, 0, p.x as i64, p.y as i64, p.w as i64, p.h as i64, 0]);
        }

        // Apps opening (not the ones starting at login, right after him) and closing.
        if self.last_ids.is_some() {
            for (pid, exe) in &now_apps {
                if !self.apps.contains_key(pid) && started.elapsed() > Duration::from_secs(30) {
                    news.push(serde_json::json!({"t": "launch", "c": util::kind(exe), "name": util::app_name(exe)}));
                }
            }
            for (pid, exe) in &self.apps {
                if !now_apps.contains_key(pid) && !now_apps.values().any(|e| e == exe) {
                    if util::kind(exe) == "music" {
                        news.push(serde_json::json!({"t": "music", "on": false}));
                    }
                    news.push(serde_json::json!({"t": "quit", "c": util::kind(exe), "name": util::app_name(exe)}));
                }
            }
        }
        self.apps = now_apps;

        // The taskbar: a step along the bottom of the screen, like the Dock (only while it is really there).
        if !covered {
            if let Ok(tb) = unsafe { FindWindowW(w!("Shell_TrayWnd"), None) } {
                if let Some(r) = util::visible_rect(tb) {
                    let on_screen = r.intersects(&screen) && r.y > screen.y + screen.h / 2 && r.bottom() <= screen.bottom() + 2 && r.y < screen.bottom() - 8 && r.h < 220;
                    if on_screen && unsafe { IsWindowVisible(tb).as_bool() } {
                        let p = f.page(&r);
                        out.push([-1000, 2, p.x as i64, p.y as i64, p.w as i64, p.h as i64, 0]);
                    }
                }
            }
        }

        // Desktop icons, asked from Explorer every few seconds (a busy Explorer must not slow down every look).
        if self.icons_at.is_none_or(|t| t.elapsed() > Duration::from_secs(6)) {
            self.icons = desktop_icons(f.scale).unwrap_or_default();
            self.icons_at = Some(Instant::now());
        }
        for (i, r) in self.icons.iter().enumerate() {
            let p = f.page(r);
            if p.intersects(&bounds) {
                out.push([-1 - i as i64, 1, p.x as i64, p.y as i64, p.w as i64, p.h as i64, 0]);
            }
        }

        // Only once things have settled (a first look shows every window at once).
        let news = if news.len() <= 2 { news.into_iter().map(|n| n.to_string()).collect() } else { Vec::new() };
        self.last_ids = Some(ids);
        let b: Vec<String> = out.iter().map(|a| format!("[{}]", a.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(","))).collect();
        (format!("{{\"b\":[{}],\"a\":{}}}", b.join(","), serde_json::Value::Object(apps_json)), news)
    }
}

/// The icons on the desktop, in screen pixels, from Explorer's own desktop view (the documented Shell way).
fn desktop_icons(scale: f64) -> windows::core::Result<Vec<Rect>> {
    unsafe {
        // Hidden desktop icons ("Show desktop icons" off) stay in the view's list: check the list window first.
        let progman = FindWindowW(w!("Progman"), None)?;
        let mut defview = FindWindowExW(Some(progman), None, w!("SHELLDLL_DefView"), None).ok();
        if defview.is_none() {
            // With a wallpaper slideshow the view lives in a WorkerW window instead.
            let mut after: Option<HWND> = None;
            while let Ok(wk) = FindWindowExW(None, after, w!("WorkerW"), None) {
                if let Ok(d) = FindWindowExW(Some(wk), None, w!("SHELLDLL_DefView"), None) {
                    defview = Some(d);
                    break;
                }
                after = Some(wk);
            }
        }
        let Some(defview) = defview else { return Ok(Vec::new()) };
        let list = FindWindowExW(Some(defview), None, w!("SysListView32"), None)?;
        if !IsWindowVisible(list).as_bool() {
            return Ok(Vec::new());
        }
        let mut origin = POINT::default();
        let _ = ClientToScreen(list, &mut origin);

        let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL)?;
        let loc = VARIANT::from(0i32); // CSIDL_DESKTOP
        let empty = VARIANT::default();
        let mut hwnd = 0i32;
        let disp = windows.FindWindowSW(&loc, &empty, SWC_DESKTOP, &mut hwnd, SWFO_NEEDDISPATCH)?;
        let sp: IServiceProvider = disp.cast()?;
        let browser: IShellBrowser = sp.QueryService(&SID_STopLevelBrowser)?;
        let view = browser.QueryActiveShellView()?;
        let fv: IFolderView = view.cast()?;
        let mut spacing = POINT::default();
        fv.GetSpacing(&mut spacing)?;
        let mut icon = 48i32;
        if let Ok(fv2) = view.cast::<IFolderView2>() {
            let mut mode = FOLDERVIEWMODE::default();
            let _ = fv2.GetViewModeAndIconSize(&mut mode, &mut icon);
        }
        let size = ((icon as f64) * scale.max(1.0)).round() as i32;
        let n = fv.ItemCount(SVGIO_ALLVIEW)?.min(60);
        let mut out = Vec::new();
        for i in 0..n {
            let Ok(pidl) = fv.Item(i) else { continue };
            let pos = fv.GetItemPosition(pidl);
            CoTaskMemFree(Some(pidl as *const _));
            let Ok(pt) = pos else { continue };
            // The icon image sits centred at the top of its cell (the label is below it).
            let x = origin.x + pt.x + (spacing.x - size).max(0) / 2;
            let y = origin.y + pt.y + 2;
            out.push(Rect { x, y, w: size, h: size });
        }
        let _ = RECT::default();
        Ok(out)
    }
}
