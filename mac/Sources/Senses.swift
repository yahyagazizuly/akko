// What happens on the computer, for him to react to: which app came to the front (and where its window is),
// music starting or stopping, the charger and the battery, the person leaving the computer and coming back,
// typing for a while, copying something (only that it happened), dark mode, the internet, apps being closed.
// (New windows, notification banners and screenshots are noticed by World, which looks at the windows anyway.)
// None of it needs a permission: app switches and player notifications are public, idle time and power are
// system counters. Only the kind of app is passed on, never what is in it.

import AppKit
import IOKit.ps
import Network

final class Senses {
    /// Called with an event as JSON for desk.sense().
    var send: ((String) -> Void)?
    weak var world: World?

    private var timer: Timer?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var away = false
    private var power: (plugged: Bool, level: Int)?
    private var ticks = 0
    private var fast: Timer?
    private var typing = false, typingSince: Date?
    private var pasteCount = NSPasteboard.general.changeCount
    private var net: NWPathMonitor?
    private var online: Bool?
    private let me = ProcessInfo.processInfo.processIdentifier

    /// The kind of app, from its bundle id: what he has something to say about.
    static func kind(_ bundle: String?) -> String {
        let b = (bundle ?? "").lowercased()
        let table: [(String, [String])] = [
            ("ai", ["com.anthropic", "com.openai", "chatgpt", "perplexity"]),
            ("chat", ["whatsapp", "telegram", "com.apple.mobilesms", "slack", "discord", "viber", "signal", "messenger", "skype", "teams"]),
            ("code", ["com.apple.dt.xcode", "com.microsoft.vscode", "todesktop", "cursor", "com.apple.terminal", "iterm", "warp", "jetbrains", "sublime", "zed", "nova", "ghostty", "kitty", "alacritty"]),
            ("music", ["com.apple.music", "spotify", "yandex.music", "ru.yandex.desktop.music", "soundcloud", "deezer", "tidal"]),
            // Arc (company.thebrowser.Browser), Yandex (…yandex-browser) and Zen (…zen-browser) are "browser" already;
            // a bare "arc" / "yandex" made Archive Utility and Yandex Music browsers.
            ("browser", ["safari", "chrome", "firefox", "browser", "edgemac", "opera", "vivaldi", "orion"]),
            ("video", ["quicktime", "iina", "vlc", "com.apple.tv", "netflix", "infuse", "youtube"]),
            ("mail", ["com.apple.mail", "outlook", "spark", "airmail", "mimestream", "thunderbird"]),
            ("notes", ["com.apple.notes", "notion", "obsidian", "textedit", "com.apple.iwork.pages", "com.microsoft.word", "bear", "craft", "evernote", "ulysses"]),
            ("design", ["figma", "sketch", "photoshop", "illustrator", "pixelmator", "affinity", "com.apple.photos", "com.apple.preview", "canva"]),
            ("files", ["com.apple.finder", "forklift", "pathfinder"]),
            ("settings", ["systempreferences", "com.apple.settings", "activitymonitor"]),
        ]
        for (k, keys) in table where keys.contains(where: { b.contains($0) }) { return k }
        return "other"
    }

    static func json(_ d: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: d), let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }

    func start() {
        guard timer == nil else { return }
        let ws = NSWorkspace.shared.notificationCenter
        observers.append((ws, ws.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] n in
            guard let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.frontChanged(app)
        }))
        let dnc = DistributedNotificationCenter.default()
        for name in ["com.apple.Music.playerInfo", "com.apple.iTunes.playerInfo", "com.spotify.client.PlaybackStateChanged"] {
            observers.append((dnc, dnc.addObserver(forName: Notification.Name(name), object: nil, queue: .main) { [weak self] n in
                let state = n.userInfo?["Player State"] as? String ?? ""
                self?.send?(Senses.json(["t": "music", "on": state == "Playing"]))
            }))
        }
        observers.append((ws, ws.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] n in
            guard let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, app.activationPolicy == .regular,
                  let name = app.localizedName else { return }
            let c = Senses.kind(app.bundleIdentifier)
            // A player closed while playing never says it stopped.
            if c == "music" { self?.send?(Senses.json(["t": "music", "on": false])) }
            self?.send?(Senses.json(["t": "quit", "c": c, "name": name]))
        }))
        let started = Date()
        observers.append((ws, ws.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] n in
            // Not the apps opening at login, right after he starts.
            guard Date().timeIntervalSince(started) > 30, let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.activationPolicy == .regular, let name = app.localizedName else { return }
            self?.send?(Senses.json(["t": "launch", "c": Senses.kind(app.bundleIdentifier), "name": name]))
        }))
        observers.append((ws, ws.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.send?(Senses.json(["t": "space"]))
        }))
        // A finished download (Safari and the system post this; only that it happened is passed on).
        observers.append((dnc, dnc.addObserver(forName: Notification.Name("com.apple.DownloadFileFinished"), object: nil, queue: .main) { [weak self] _ in
            self?.send?(Senses.json(["t": "download"]))
        }))
        observers.append((dnc, dnc.addObserver(forName: Notification.Name("AppleInterfaceThemeChangedNotification"), object: nil, queue: .main) { [weak self] _ in
            let dark = UserDefaults.standard.string(forKey: "AppleInterfaceStyle") == "Dark"
            self?.send?(Senses.json(["t": "theme", "dark": dark]))
        }))
        online = nil
        let m = NWPathMonitor()
        m.pathUpdateHandler = { [weak self] path in
            let on = path.status == .satisfied
            DispatchQueue.main.async {
                guard let self else { return }
                if let was = self.online, was != on { self.send?(Senses.json(["t": "net", "on": on])) }
                self.online = on
            }
        }
        m.start(queue: .global(qos: .utility))
        net = m
        // Typing and copying, once a second: a key-press counter and the clipboard's change count (never its contents).
        pasteCount = NSPasteboard.general.changeCount
        let f = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.quick() }
        f.tolerance = 0.3
        RunLoop.main.add(f, forMode: .common)
        fast = f
        // Idle time every 5 s, power every 15 s: two cheap system counters.
        let t = Timer(timeInterval: 5, repeats: true) { [weak self] _ in self?.tick() }
        t.tolerance = 1.5
        RunLoop.main.add(t, forMode: .common)
        timer = t
        power = nil
        tick()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        fast?.invalidate()
        fast = nil
        net?.cancel()
        net = nil
        typing = false
        typingSince = nil
        for (c, o) in observers { c.removeObserver(o) }
        observers = []
    }

    private func quick() {
        // Typing: keys pressed within the last 2 s, for 20 s in a row; stopped after 6 s without a key.
        let sinceKey = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
        if sinceKey < 2 {
            if typingSince == nil { typingSince = Date() }
            if !typing, Date().timeIntervalSince(typingSince!) > 20 { typing = true; send?(Senses.json(["t": "typing", "on": true])) }
        } else if sinceKey > 6 {
            typingSince = nil
            if typing { typing = false; send?(Senses.json(["t": "typing", "on": false])) }
        }
        let c = NSPasteboard.general.changeCount
        if c != pasteCount { pasteCount = c; send?(Senses.json(["t": "copy"])) }
    }

    private func tick() {
        // Seconds since the last key press, click or mouse move (any kind of input).
        let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
        if !away, idle > 120 { away = true; send?(Senses.json(["t": "away", "on": true])) }
        else if away, idle < 4 { away = false; send?(Senses.json(["t": "away", "on": false])) }
        // Also the moments the page waits for: reaching 100 % ("full") and dropping to 15 % ("tired"), which a 5 % step can miss.
        if ticks % 3 == 0, let p = Senses.battery(),
           power == nil || p.plugged != power!.plugged || abs(p.level - power!.level) >= 5
            || (p.level >= 100) != (power!.level >= 100) || (p.level <= 15) != (power!.level <= 15) {
            power = p
            send?(Senses.json(["t": "power", "plugged": p.plugged, "level": p.level]))
        }
        ticks += 1
    }

    /// Plugged in, and the charge in percent. nil on a Mac without a battery.
    static func battery() -> (plugged: Bool, level: Int)? {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else { return nil }
        for ps in list {
            guard let d = IOPSGetPowerSourceDescription(info, ps)?.takeUnretainedValue() as? [String: Any],
                  (d[kIOPSTypeKey] as? String) == kIOPSInternalBatteryType else { continue }
            let cur = d[kIOPSCurrentCapacityKey] as? Int ?? 0, max = d[kIOPSMaxCapacityKey] as? Int ?? 100
            return ((d[kIOPSPowerSourceStateKey] as? String) == kIOPSACPowerValue, max > 0 ? cur * 100 / max : cur)
        }
        return nil
    }

    private func frontChanged(_ app: NSRunningApplication) {
        guard app.processIdentifier != me else { return }
        var e: [String: Any] = ["t": "app", "c": Senses.kind(app.bundleIdentifier)]
        // Its front window, if it has one on this screen.
        if let world, let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
            for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier && (w[kCGWindowLayer as String] as? Int) == 0 {
                guard let b = w[kCGWindowBounds as String] as? [String: Double], let id = w[kCGWindowNumber as String] as? Int else { continue }
                let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
                if r.width < 100 || r.height < 50 { continue }
                let p = world.page(r)
                guard p.intersects(CGRect(origin: .zero, size: world.panelFrame.size)) else { break }
                e["id"] = id; e["x"] = Int(p.minX); e["y"] = Int(p.minY); e["w"] = Int(p.width); e["h"] = Int(p.height)
                break
            }
        }
        send?(Senses.json(e))
    }
}
