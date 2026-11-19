// The same settings as the macOS app, kept in %APPDATA%\Akko\settings.json.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub visible: bool,
    pub paused: bool,
    pub size: i32,
    /// "auto" (on battery or battery saver), "on", "off"
    pub power: String,
    /// Monitor to walk on, by its device name (\\.\DISPLAY1); None = the primary one.
    pub screen: Option<String>,
    pub hide_video: bool,
    pub hide_full_screen: bool,
    /// Off: while the screen is recorded or shared he stays out (for demos). On: he hides from the recording.
    pub hide_capture: bool,
    pub menu_icon: bool,
    pub welcomed: bool,
    pub climb: bool,
    pub lang: String,
    pub senses: bool,
    pub activity: i32,
    pub chatty: i32,
    pub breaks: bool,
    pub night_sleep: bool,
    pub follow: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            visible: true,
            paused: false,
            size: 44,
            power: "auto".into(),
            screen: None,
            hide_video: true,
            hide_full_screen: true,
            hide_capture: false,
            menu_icon: true,
            welcomed: false,
            climb: true,
            lang: "en".into(),
            senses: true,
            activity: 1,
            chatty: 1,
            breaks: true,
            night_sleep: true,
            follow: true,
        }
    }
}

pub fn dir() -> PathBuf {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Akko")
}

impl Settings {
    pub fn load() -> Settings {
        std::fs::read_to_string(dir().join("settings.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        let d = dir();
        let _ = std::fs::create_dir_all(&d);
        if let Ok(s) = serde_json::to_string_pretty(self) {
            // Write then rename: a crash mid-write never leaves a broken file.
            let tmp = d.join("settings.json.tmp");
            if std::fs::write(&tmp, s).is_ok() {
                let _ = std::fs::rename(&tmp, d.join("settings.json"));
            }
        }
    }

    /// Apply one change from the settings window: {"k": key, "v": value}.
    pub fn set(&mut self, k: &str, v: &serde_json::Value) {
        let b = || v.as_bool().unwrap_or(false);
        let i = || v.as_i64().unwrap_or(0) as i32;
        let s = || v.as_str().unwrap_or("").to_string();
        match k {
            "visible" => self.visible = b(),
            "paused" => self.paused = b(),
            "size" => self.size = i().clamp(24, 120),
            "power" => self.power = s(),
            "hideVideo" => self.hide_video = b(),
            "hideFullScreen" => self.hide_full_screen = b(),
            "hideCapture" => self.hide_capture = b(),
            "menuIcon" => self.menu_icon = b(),
            "climb" => self.climb = b(),
            "lang" => self.lang = if s() == "ru" { "ru".into() } else { "en".into() },
            "senses" => self.senses = b(),
            "activity" => self.activity = i().clamp(0, 2),
            "chatty" => self.chatty = i().clamp(0, 2),
            "breaks" => self.breaks = b(),
            "nightSleep" => self.night_sleep = b(),
            "follow" => self.follow = b(),
            _ => {}
        }
    }
}
