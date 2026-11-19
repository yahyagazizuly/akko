// What happens on the computer, for him to react to, and when to step aside on his own.
//
// Senses (same events as on the Mac): music starting or stopping, the charger and the battery, the person
// leaving the computer and coming back, typing for a while, copying something (only that it happened),
// dark mode, the internet. None of it needs a permission, and only the kind of thing is passed on.
//
// Auto-hide signals, every 2 s:
// - video: a browser or player reports media playing (Windows' media sessions), or an app is using the
//   microphone (a call) — the Windows counterpart of the Mac's "keep the display awake" check;
// - full screen: the app in front fills the screen and is a game, a presentation or a video player;
// - capture: the screen is being recorded or shared (OBS, Zoom's share helper, the Snipping Tool recorder…).

use crate::util;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as MediaManager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Playback,
};
use windows::Win32::Foundation::{CloseHandle, HWND, POINT};
use windows::Win32::Networking::NetworkListManager::{INetworkListManager, NetworkListManager};
use windows::Win32::System::Com::{CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx};
use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_READ, RRF_RT_REG_DWORD, RRF_RT_REG_QWORD, RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW,
};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO, VK_SNAPSHOT};
use windows::Win32::UI::Shell::{QUERY_USER_NOTIFICATION_STATE, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState};
use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetCursorPos, GetForegroundWindow};
use windows::core::{HSTRING, PCWSTR, PWSTR, w};

#[derive(Clone, Default)]
pub struct Control {
    /// Pass events to the page (he is out and "react to apps" is on).
    pub senses: bool,
    /// Work out the auto-hide signals.
    pub watch: bool,
    pub frame: util::Frame,
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Signals {
    pub video: bool,
    pub fullscreen: bool,
    pub capture: bool,
}

pub enum Out {
    Sense(String),
    Signals(Signals),
    /// Plugged in / unplugged / battery saver changed: the power-saving mode may change.
    Power,
}

pub fn spawn(ctl: Arc<Mutex<Control>>, send: impl Fn(Out) + Send + 'static) {
    std::thread::spawn(move || {
        unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
        let mut s = State::default();
        let mut tick = 0u64;
        loop {
            let c = ctl.lock().unwrap().clone();
            if c.watch && tick % 2 == 0 {
                let sig = Signals { video: s.video_playing(), fullscreen: front_is_full_screen_show(&c.frame), capture: capturing() };
                send(Out::Signals(sig));
            }
            if tick % 15 == 0 {
                let p = power();
                if p.map(|p| (p.plugged, p.saver)) != s.power.map(|p| (p.plugged, p.saver)) {
                    send(Out::Power);
                }
                if c.senses {
                    if let Some(p) = p {
                        let changed = match s.power {
                            None => true,
                            Some(o) => o.plugged != p.plugged || (o.level - p.level).abs() >= 5 || (o.level >= 100) != (p.level >= 100) || (o.level <= 15) != (p.level <= 15),
                        };
                        if changed && p.has_battery {
                            send(Out::Sense(serde_json::json!({"t": "power", "plugged": p.plugged, "level": p.level}).to_string()));
                        }
                    }
                }
                s.power = p;
            }
            if c.senses {
                s.quick(&send);
                if tick % 5 == 0 {
                    s.slow(&send);
                }
            } else {
                s.reset();
            }
            tick += 1;
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

#[derive(Clone, Copy, PartialEq)]
pub struct Power {
    pub plugged: bool,
    pub level: i32,
    pub saver: bool,
    pub has_battery: bool,
}

/// Plugged in, the charge in percent, and battery saver.
pub fn power() -> Option<Power> {
    let mut st = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut st).ok()? };
    let has_battery = st.BatteryFlag & 128 == 0 && st.BatteryLifePercent != 255;
    Some(Power { plugged: st.ACLineStatus != 0, level: if has_battery { st.BatteryLifePercent as i32 } else { 100 }, saver: st.SystemStatusFlag == 1, has_battery })
}

/// Power saving "auto": on battery, or with battery saver on.
pub fn on_battery_or_saver() -> bool { power().is_some_and(|p| (p.has_battery && !p.plugged) || p.saver) }

#[derive(Default)]
struct State {
    power: Option<Power>,
    away: bool,
    typing: bool,
    typing_since: Option<Instant>,
    /// Last input time and cursor position: input with the cursor still means a key was pressed.
    input: Option<(u32, (i32, i32))>,
    last_key: Option<Instant>,
    clip: Option<u32>,
    dark: Option<bool>,
    online: Option<bool>,
    music: Option<bool>,
    media: Option<MediaManager>,
    net: Option<INetworkListManager>,
}

impl State {
    fn reset(&mut self) {
        self.typing = false;
        self.typing_since = None;
        self.clip = None;
        self.music = None;
    }

    /// Every second: typing, the screenshot key and copying.
    fn quick(&mut self, send: &impl Fn(Out)) {
        // A key press, without a keyboard hook: the system's last-input time moved while the cursor stood still.
        let mut li = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        let mut pt = POINT::default();
        unsafe {
            let _ = GetLastInputInfo(&mut li);
            let _ = GetCursorPos(&mut pt);
        }
        let now = (li.dwTime, (pt.x, pt.y));
        if let Some((t, p)) = self.input {
            if t != now.0 && p == now.1 {
                self.last_key = Some(Instant::now());
            }
        }
        self.input = Some(now);
        // Print Screen: "pressed since the last check".
        if unsafe { GetAsyncKeyState(VK_SNAPSHOT.0 as i32) } & 1 != 0 {
            send(Out::Sense(r#"{"t":"shot"}"#.into()));
        }
        // Typing: keys pressed within the last 2 s, for 20 s in a row; stopped after 6 s without a key.
        let since_key = self.last_key.map_or(f64::MAX, |t| t.elapsed().as_secs_f64());
        if since_key < 2.0 {
            let t = *self.typing_since.get_or_insert_with(Instant::now);
            if !self.typing && t.elapsed() > Duration::from_secs(20) {
                self.typing = true;
                send(Out::Sense(r#"{"t":"typing","on":true}"#.into()));
            }
        } else if since_key > 6.0 {
            self.typing_since = None;
            if self.typing {
                self.typing = false;
                send(Out::Sense(r#"{"t":"typing","on":false}"#.into()));
            }
        }
        // The clipboard's change counter (never its contents).
        let c = unsafe { GetClipboardSequenceNumber() };
        if self.clip.is_some_and(|o| o != c) {
            send(Out::Sense(r#"{"t":"copy"}"#.into()));
        }
        self.clip = Some(c);
    }

    /// Every 5 s: away, dark mode, the internet, music.
    fn slow(&mut self, send: &impl Fn(Out)) {
        let idle = idle_seconds();
        if !self.away && idle > 120.0 {
            self.away = true;
            send(Out::Sense(r#"{"t":"away","on":true}"#.into()));
        } else if self.away && idle < 4.0 {
            self.away = false;
            send(Out::Sense(r#"{"t":"away","on":false}"#.into()));
        }
        let dark = dark_mode();
        if self.dark.is_some_and(|d| d != dark) {
            send(Out::Sense(serde_json::json!({"t": "theme", "dark": dark}).to_string()));
        }
        self.dark = Some(dark);
        if let Some(on) = self.online_now() {
            if self.online.is_some_and(|o| o != on) {
                send(Out::Sense(serde_json::json!({"t": "net", "on": on}).to_string()));
            }
            self.online = Some(on);
        }
        let m = self.media_playing().map(|(music, _)| music);
        if let Some(m) = m {
            if self.music != Some(m) {
                if self.music.is_some() || m {
                    send(Out::Sense(serde_json::json!({"t": "music", "on": m}).to_string()));
                }
                self.music = Some(m);
            }
        }
    }

    fn online_now(&mut self) -> Option<bool> {
        if self.net.is_none() {
            self.net = unsafe { CoCreateInstance(&NetworkListManager, None, CLSCTX_ALL).ok() };
        }
        let n = self.net.as_ref()?;
        unsafe { n.IsConnectedToInternet().ok().map(|v| v.as_bool()) }
    }

    /// (music playing, other media playing) from the media sessions browsers and players publish.
    fn media_playing(&mut self) -> Option<(bool, bool)> {
        if self.media.is_none() {
            self.media = MediaManager::RequestAsync().ok()?.join().ok();
        }
        let m = self.media.as_ref()?;
        let sessions = m.GetSessions().ok()?;
        let (mut music, mut other) = (false, false);
        for s in sessions {
            let playing = s.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()).is_ok_and(|p| p == Playback::Playing);
            if !playing {
                continue;
            }
            let app = s.SourceAppUserModelId().map(|h: HSTRING| h.to_string_lossy().to_lowercase()).unwrap_or_default();
            let exe = app.rsplit(['\\', '!']).next().unwrap_or(&app).to_string();
            if util::kind(&exe) == "music" || ["spotify", "music", "yandex.music", "deezer", "tidal", "soundcloud"].iter().any(|k| app.contains(k)) {
                music = true;
            } else {
                other = true;
            }
        }
        Some((music, other))
    }

    /// A video or a call: media other than music playing, or the microphone in use.
    fn video_playing(&mut self) -> bool { self.media_playing().is_some_and(|(_, other)| other) || microphone_in_use() }
}

fn idle_seconds() -> f64 {
    let mut li = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe {
        if !GetLastInputInfo(&mut li).as_bool() {
            return 0.0;
        }
        GetTickCount().wrapping_sub(li.dwTime) as f64 / 1000.0
    }
}

fn reg_dword(root: HKEY, key: PCWSTR, name: PCWSTR) -> Option<u32> {
    let mut v = 0u32;
    let mut len = 4u32;
    unsafe { RegGetValueW(root, key, name, RRF_RT_REG_DWORD, None, Some(&mut v as *mut _ as *mut _), Some(&mut len)).ok().ok()? };
    Some(v)
}

pub fn dark_mode() -> bool {
    reg_dword(HKEY_CURRENT_USER, w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"), w!("AppsUseLightTheme")) == Some(0)
}

/// An app is using the microphone right now (a call): Windows keeps "last used" times per app, and a start
/// without a stop means in use. Read from the registry; no permission and no audio access.
fn microphone_in_use() -> bool {
    fn in_use(key: HKEY) -> bool {
        let mut stop = 0u64;
        let mut start = 0u64;
        let mut len = 8u32;
        unsafe {
            let a = RegGetValueW(key, None, w!("LastUsedTimeStop"), RRF_RT_REG_QWORD, None, Some(&mut stop as *mut _ as *mut _), Some(&mut len)).is_ok();
            len = 8;
            let b = RegGetValueW(key, None, w!("LastUsedTimeStart"), RRF_RT_REG_QWORD, None, Some(&mut start as *mut _ as *mut _), Some(&mut len)).is_ok();
            a && b && stop == 0 && start != 0
        }
    }
    fn scan(path: &str, depth: u32) -> bool {
        unsafe {
            let mut key = HKEY::default();
            let p = HSTRING::from(path);
            if RegOpenKeyExW(HKEY_CURRENT_USER, &p, Some(0), KEY_READ, &mut key).is_err() {
                return false;
            }
            let mut found = false;
            let mut i = 0u32;
            loop {
                let mut name = [0u16; 512];
                let mut len = name.len() as u32;
                if RegEnumKeyExW(key, i, Some(PWSTR(name.as_mut_ptr())), &mut len, None, None, None, None).is_err() {
                    break;
                }
                let sub = String::from_utf16_lossy(&name[..len as usize]);
                i += 1;
                if sub == "NonPackaged" {
                    if depth == 0 && scan(&format!("{path}\\NonPackaged"), 1) {
                        found = true;
                        break;
                    }
                    continue;
                }
                let mut k = HKEY::default();
                let sp = HSTRING::from(format!("{path}\\{sub}"));
                if RegOpenKeyExW(HKEY_CURRENT_USER, &sp, Some(0), KEY_READ, &mut k).is_ok() {
                    let u = in_use(k);
                    let _ = RegCloseKey(k);
                    if u {
                        found = true;
                        break;
                    }
                }
            }
            let _ = RegCloseKey(key);
            found
        }
    }
    scan("Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone", 0)
}

/// The screen is being recorded or shared: recorders and share helpers that run only while capturing.
/// (Sharing from a browser tab, as in Google Meet, can't be seen from outside.)
pub fn capturing() -> bool {
    let names: HashSet<&str> = ["obs64.exe", "obs32.exe", "obs.exe", "cpthost.exe", "screenclippinghost.exe", "bdcam.exe", "camtasiarecorder.exe", "screenstudio.exe", "kap.exe"].into_iter().collect();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return false };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = false;
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let n = String::from_utf16_lossy(&e.szExeFile[..e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len())]).to_lowercase();
                if names.contains(n.as_str()) {
                    found = true;
                    break;
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        found
    }
}

/// A game, a presentation or a video player fills the screen. Other apps on the whole screen (a chat, an editor,
/// a browser) are no reason to hide: he keeps them company. (Videos in a browser are caught by video_playing.)
pub fn front_is_full_screen_show(f: &util::Frame) -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() || util::pid_of(fg) == std::process::id() {
            return false;
        }
        let state: QUERY_USER_NOTIFICATION_STATE = SHQueryUserNotificationState().unwrap_or_default();
        if state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE {
            return true;
        }
        let Some(r) = util::visible_rect(fg) else { return false };
        let s = f.r;
        let full = r.x <= s.x + 1 && r.y <= s.y + 1 && r.right() >= s.right() - 1 && r.bottom() >= s.bottom() - 1;
        if !full {
            return false;
        }
        let pid = util::pid_of(fg);
        let exe = util::exe_of(pid);
        if util::kind(&exe) == "video" {
            return true;
        }
        // PowerPoint's slide show window, and other presentation apps.
        if exe == "powerpnt.exe" && class(fg) == "screenClass" {
            return true;
        }
        if ["pptview.exe", "keynote.exe", "prezi.exe"].contains(&exe.as_str()) {
            return true;
        }
        // Games installed by the usual launchers.
        let path = exe_path(pid).to_lowercase();
        ["\\steamapps\\", "\\epic games\\", "\\xboxgames\\", "\\riot games\\", "\\gog galaxy\\games\\", "\\ubisoft game launcher\\games\\", "\\battle.net\\"]
            .iter()
            .any(|k| path.contains(k))
    }
}

fn class(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn exe_path(pid: u32) -> String {
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW};
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if ok { String::from_utf16_lossy(&buf[..len as usize]) } else { String::new() }
    }
}
