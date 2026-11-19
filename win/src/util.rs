// Small Win32 helpers shared by the rest: process names, the kind of an app, window rectangles.

use windows::Win32::Foundation::{CloseHandle, HWND, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, GetWindowThreadProcessId};
use windows::core::PWSTR;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn from(r: RECT) -> Rect { Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } }
    pub fn right(&self) -> i32 { self.x + self.w }
    pub fn bottom(&self) -> i32 { self.y + self.h }
    pub fn intersects(&self, o: &Rect) -> bool {
        self.x < o.right() && o.x < self.right() && self.y < o.bottom() && o.y < self.bottom()
    }
}

/// Where the overlay is (physical pixels) and its scale: screen pixels → page CSS pixels.
#[derive(Clone, Copy, Debug, Default)]
pub struct Frame {
    pub r: Rect,
    pub scale: f64,
}

impl Frame {
    pub fn page(&self, r: &Rect) -> Rect {
        let s = if self.scale > 0.0 { self.scale } else { 1.0 };
        Rect {
            x: ((r.x - self.r.x) as f64 / s).round() as i32,
            y: ((r.y - self.r.y) as f64 / s).round() as i32,
            w: (r.w as f64 / s).round() as i32,
            h: (r.h as f64 / s).round() as i32,
        }
    }
    pub fn page_bounds(&self) -> Rect {
        let s = if self.scale > 0.0 { self.scale } else { 1.0 };
        Rect { x: 0, y: 0, w: (self.r.w as f64 / s) as i32, h: (self.r.h as f64 / s) as i32 }
    }
}

pub fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

/// The executable's file name ("chrome.exe"), lower case.
pub fn exe_of(pid: u32) -> String {
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit('\\').next().unwrap_or("").to_lowercase()
    }
}

/// The visible frame of a window (without the invisible resize border and shadow).
pub fn visible_rect(hwnd: HWND) -> Option<Rect> {
    unsafe {
        let mut r = RECT::default();
        if DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut _ as *mut _, std::mem::size_of::<RECT>() as u32).is_ok() {
            return Some(Rect::from(r));
        }
        if GetWindowRect(hwnd, &mut r).is_ok() { Some(Rect::from(r)) } else { None }
    }
}

/// Windows hidden on another virtual desktop or suspended UWP apps are "cloaked": on screen for the API, not for people.
pub fn cloaked(hwnd: HWND) -> bool {
    let mut c = 0u32;
    unsafe {
        DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut c as *mut _ as *mut _, 4).is_ok() && c != 0
    }
}

/// The kind of app, from its executable: what he has something to say about (same kinds as on the Mac).
pub fn kind(exe: &str) -> &'static str {
    let e = exe.trim_end_matches(".exe");
    let table: &[(&str, &[&str])] = &[
        ("ai", &["claude", "chatgpt", "perplexity", "copilot"]),
        ("chat", &["whatsapp", "telegram", "slack", "discord", "viber", "signal", "messenger", "skype", "teams", "ms-teams", "zoom"]),
        ("code", &["code", "cursor", "devenv", "idea64", "pycharm64", "webstorm64", "rider64", "clion64", "goland64", "sublime_text", "zed", "windowsterminal", "wt", "powershell", "pwsh", "cmd", "alacritty", "wezterm-gui", "notepad++"]),
        ("music", &["spotify", "applemusic", "music.ui", "yandexmusic", "deezer", "tidal", "itunes", "foobar2000", "aimp"]),
        ("browser", &["chrome", "msedge", "firefox", "opera", "brave", "vivaldi", "browser", "arc", "zen", "yandex"]),
        ("video", &["vlc", "mpc-hc64", "mpc-be64", "potplayermini64", "netflix", "mpv", "video.ui", "wmplayer", "microsoft.media.player"]),
        ("mail", &["outlook", "olk", "hxoutlook", "thunderbird", "mailspring"]),
        ("notes", &["notion", "obsidian", "notepad", "winword", "onenote", "evernote", "wordpad"]),
        ("design", &["figma", "photoshop", "illustrator", "afdesign", "afphoto", "paint", "mspaint", "photos", "canva", "gimp-2.10", "krita", "blender"]),
        ("files", &["explorer", "totalcmd64", "files"]),
        ("settings", &["systemsettings", "taskmgr", "control", "mmc"]),
    ];
    for (k, keys) in table {
        if keys.iter().any(|x| e == *x || (x.len() > 4 && e.contains(x))) {
            return k;
        }
    }
    "other"
}

/// A friendly name for an app ("пока, Chrome!"), from its executable.
pub fn app_name(exe: &str) -> String {
    let e = exe.trim_end_matches(".exe");
    let known: &[(&str, &str)] = &[
        ("msedge", "Edge"), ("chrome", "Chrome"), ("firefox", "Firefox"), ("code", "VS Code"), ("winword", "Word"),
        ("excel", "Excel"), ("powerpnt", "PowerPoint"), ("outlook", "Outlook"), ("olk", "Outlook"), ("explorer", "Explorer"),
        ("windowsterminal", "Terminal"), ("spotify", "Spotify"), ("telegram", "Telegram"), ("whatsapp", "WhatsApp"),
        ("discord", "Discord"), ("slack", "Slack"), ("ms-teams", "Teams"), ("teams", "Teams"), ("zoom", "Zoom"),
        ("notepad", "Notepad"), ("claude", "Claude"), ("chatgpt", "ChatGPT"), ("figma", "Figma"), ("notion", "Notion"),
        ("obsidian", "Obsidian"), ("vlc", "VLC"), ("brave", "Brave"), ("opera", "Opera"), ("cursor", "Cursor"),
    ];
    if let Some((_, n)) = known.iter().find(|(k, _)| *k == e) {
        return n.to_string();
    }
    let mut c = e.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

