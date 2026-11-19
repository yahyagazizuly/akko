// Akko for macOS: a native menu-bar app. A transparent panel covers the screen below the menu bar (he
// walks along the bottom of the screen and climbs the Dock, windows and icons) and lets every click through, except when the cursor is over him. He is drawn by the
// Akko library in the system WebKit, so the app is tiny and light.

import AppKit
import WebKit
import Carbon.HIToolbox
import IOKit.ps
import ServiceManagement

// MARK: - Settings

final class Settings {
    private let d = UserDefaults.standard
    init() {
        d.register(defaults: ["visible": true, "paused": false, "size": 44, "power": "auto",
                              "hideVideo": true, "hideFullScreen": true, "hideCapture": false, "menuIcon": true, "welcomed": false, "climb": true,
                              "lang": "en", "senses": true, "activity": 1, "chatty": 1, "breaks": true,
                              "nightSleep": true, "follow": true])
    }
    var visible: Bool { get { d.bool(forKey: "visible") } set { d.set(newValue, forKey: "visible") } }
    var paused: Bool { get { d.bool(forKey: "paused") } set { d.set(newValue, forKey: "paused") } }
    var size: Int { get { d.integer(forKey: "size") } set { d.set(newValue, forKey: "size") } }
    /// "auto" (on battery or Low Power Mode), "on", "off"
    var power: String { get { d.string(forKey: "power") ?? "auto" } set { d.set(newValue, forKey: "power") } }
    var screenID: Int? { get { d.object(forKey: "screen") as? Int } set { d.set(newValue, forKey: "screen") } }
    var hideVideo: Bool { get { d.bool(forKey: "hideVideo") } set { d.set(newValue, forKey: "hideVideo") } }
    var hideFullScreen: Bool { get { d.bool(forKey: "hideFullScreen") } set { d.set(newValue, forKey: "hideFullScreen") } }
    /// Off (the default): while the screen is recorded or shown in a call he stays out — handy for demos —
    /// even if a video or a full-screen show would otherwise send him away. On: he hides from the recording.
    var hideCapture: Bool { get { d.bool(forKey: "hideCapture") } set { d.set(newValue, forKey: "hideCapture") } }
    var menuIcon: Bool { get { d.bool(forKey: "menuIcon") } set { d.set(newValue, forKey: "menuIcon") } }
    var welcomed: Bool { get { d.bool(forKey: "welcomed") } set { d.set(newValue, forKey: "welcomed") } }
    /// Climb windows, the Dock and desktop icons.
    var climb: Bool { get { d.bool(forKey: "climb") } set { d.set(newValue, forKey: "climb") } }
    /// The language he speaks: "en" or "ru".
    var lang: String { get { d.string(forKey: "lang") ?? "en" } set { d.set(newValue, forKey: "lang") } }
    /// React to what happens on the computer (apps, music, notifications, typing…).
    var senses: Bool { get { d.bool(forKey: "senses") } set { d.set(newValue, forKey: "senses") } }
    /// 0 calm, 1 normal, 2 hyper.
    var activity: Int { get { d.integer(forKey: "activity") } set { d.set(newValue, forKey: "activity") } }
    /// 0 quiet, 1 normal, 2 chatterbox.
    var chatty: Int { get { d.integer(forKey: "chatty") } set { d.set(newValue, forKey: "chatty") } }
    var breaks: Bool { get { d.bool(forKey: "breaks") } set { d.set(newValue, forKey: "breaks") } }
    var nightSleep: Bool { get { d.bool(forKey: "nightSleep") } set { d.set(newValue, forKey: "nightSleep") } }
    var follow: Bool { get { d.bool(forKey: "follow") } set { d.set(newValue, forKey: "follow") } }
}

// MARK: - Window pieces

/// Never becomes key or main: he never steals focus from what you are doing.
final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Takes the very first click, so grabbing him works without an "activate window" click.
final class OverlayWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// NSMenuItem with a closure.
final class Item: NSMenuItem {
    private let run: () -> Void
    init(_ title: String, key: String = "", mods: NSEvent.ModifierFlags = .command, on: Bool? = nil, enabled: Bool = true, _ run: @escaping () -> Void = {}) {
        self.run = run
        super.init(title: title, action: #selector(fire), keyEquivalent: key)
        target = self
        keyEquivalentModifierMask = mods
        if let on { state = on ? .on : .off }
        isEnabled = enabled
    }
    required init(coder: NSCoder) { fatalError() }
    @objc private func fire() { run() }
}

/// Sets a WebKit feature flag by key, if this WebKit has it.
func setWebKitFeature(_ prefs: WKPreferences, _ key: String, _ on: Bool) {
    let list = NSSelectorFromString("_features"), set = NSSelectorFromString("_setEnabled:forFeature:")
    guard (WKPreferences.self as AnyObject).responds(to: list), prefs.responds(to: set),
          let features = (WKPreferences.self as AnyObject).perform(list)?.takeUnretainedValue() as? [NSObject],
          let feature = features.first(where: { ($0.value(forKey: "key") as? String) == key }) else { return }
    typealias Fn = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
    unsafeBitCast(prefs.method(for: set), to: Fn.self)(prefs, set, on, feature)
}

// MARK: - App

final class App: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, NSMenuDelegate {
    static var shared: App!

    let settings = Settings()
    var panel: OverlayPanel!
    var web: OverlayWebView!
    var status: NSStatusItem!
    var cursorTimer: Timer?
    var cursorIdleTimer: Timer?
    var moveMonitor: Any?
    var lastMove = Date.distantPast
    var powerTimer: Timer?
    var hotKey: EventHotKeyRef?
    var ready = false
    var interactive = false
    /// Why the system put him to sleep ("sleep", "lock", "session"); he runs only when there is no reason left.
    /// (One flag was not enough: the screen wakes up on the lock screen before you unlock it.)
    var pauseReasons = Set<String>()
    var systemPaused: Bool { !pauseReasons.isEmpty }
    var lastCursor = CGPoint(x: -1, y: -1)
    var lastLowPower: Bool?
    var acts: [String] = []
    var lastAct = ""
    var settingsWindow: NSWindow?
    let uiModel = UIModel()
    /// Why he stepped aside on his own ("video", "fullscreen"), or nil.
    var autoHidden: String?
    var autoTimer: Timer?
    var clearSince: Date?
    let world = World()
    let senses = Senses()
    /// How he feels (0…1), from the page.
    var energy = 0.8, mood = 0.65
    var moodText: String {
        let e = energy < 0.3 ? "устал" : energy > 0.7 ? "бодрый" : "в норме"
        let m = mood < 0.35 ? "грустит 😔" : mood > 0.75 ? "счастлив 😊" : "спокоен 🙂"
        return "\(m), \(e)"
    }
    /// He is standing on a window: watch it closely so he rides along when it is dragged.
    var perched = false

    var shown: Bool { settings.visible && autoHidden == nil }
    var running: Bool { shown && !settings.paused && !systemPaused }

    var statusText: String {
        if !settings.visible { return "Спрятан" }
        if autoHidden == "video" { return "Прячется: видео" }
        if autoHidden == "fullscreen" { return "Прячется: полный экран" }
        if autoHidden == "capture" { return "Прячется: запись экрана" }
        if systemPaused { return "Спит" }
        if settings.paused { return "На паузе" }
        return "Гуляет"
    }

    func play(_ name: String?) {
        let names = actNames.filter { acts.isEmpty || acts.contains($0.0) }.map(\.0)
        if let n = name ?? names.randomElement() { js("desk.play('\(n)')") }
    }

    let actNames: [(String, String)] = [
        ("climb", "Залезть на окно 🪟"), ("icons", "По иконкам 📁"), ("dock", "На док"),
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

    func applicationDidFinishLaunching(_ n: Notification) {
        App.shared = self
        FrameCap.install()
        NSLog("chelik sight: screen recording \(Sight.allowed ? "allowed" : "not allowed"), accessibility \(AXIsProcessTrusted() ? "on" : "off")")
        world.onChange = { [unowned self] json in js("desk.world(\(json))") }
        world.onSense = { [unowned self] json in if settings.senses { js("desk.sense(\(json))") } }
        senses.world = world
        senses.send = { [unowned self] json in js("desk.sense(\(json))") }
        makePanel()
        world.panelFrame = panel.frame
        world.screen = targetScreen
        makeStatusItem()
        registerHotKey()
        observeSystem()
        apply()
        if ProcessInfo.processInfo.environment["CHELIK_FRAME"] != nil { fit() }
        if !settings.welcomed { settings.welcomed = true; showSettings() }
        if ProcessInfo.processInfo.environment["CHELIK_CAPLOG"] != nil {
            Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in NSLog("chelik framecap: capped \(FrameCap.capped) skipped \(FrameCap.skipped)") }
        }
    }

    /// Launching the app again (Finder, Launchpad, Spotlight) while it runs opens the settings.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showSettings()
        return false
    }

    // MARK: Panel + web view

    var targetScreen: NSScreen {
        NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? Int) == settings.screenID }
            // The main display (with the menu bar), not NSScreen.main: that one follows keyboard focus, so he
            // would jump screens on the next screen change and the full-screen check would look at another screen.
            ?? NSScreen.screens.first ?? NSScreen.main!
    }

    static func screenID(_ s: NSScreen) -> Int? { s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? Int }

    /// The whole screen below the menu bar: the Dock is something he climbs, not the floor.
    var area: NSRect {
        let s = targetScreen, f = s.frame
        return NSRect(x: f.minX, y: f.minY, width: f.width, height: s.visibleFrame.maxY - f.minY)
    }

    func makePanel() {
        panel = OverlayPanel(contentRect: area, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.animationBehavior = .none

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "desk")
        cfg.suppressesIncrementalRendering = true
        cfg.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        // On 120 Hz screens, draw at ~60 fps: still smooth for a little guy, half the work.
        // (A WebKit feature flag; skipped quietly if a future macOS drops it.)
        setWebKitFeature(cfg.preferences, "PreferPageRenderingUpdatesNear60FPSEnabled", true)
        // Paint his few layers in software: same CPU, but no ~110 MB of GPU drawing buffers (any SVG repaint
        // wakes the accelerated path renderer, which keeps big surfaces around).
        setWebKitFeature(cfg.preferences, "AcceleratedDrawingEnabled", false)
        // Developer hook for experiments: CHELIK_WK_OFF="FeatureA,FeatureB"
        for k in (ProcessInfo.processInfo.environment["CHELIK_WK_OFF"] ?? "").split(separator: ",") {
            setWebKitFeature(cfg.preferences, String(k), false)
        }
        web = OverlayWebView(frame: panel.contentView!.bounds, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.setValue(false, forKey: "drawsBackground")
        web.underPageBackgroundColor = .clear
        web.navigationDelegate = self
        panel.contentView = web

        let res = Bundle.main.resourceURL!
        FrameCap.root = web.layer
        web.loadFileURL(res.appendingPathComponent("web/overlay.html"), allowingReadAccessTo: res.appendingPathComponent("web"))
    }

    /// WebKit's page process can be killed (memory pressure, a WebKit crash): load him again instead of leaving
    /// an empty window that might still be catching clicks.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NSLog("chelik: web content process terminated, reloading")
        ready = false
        perched = false
        if interactive { interactive = false; panel.ignoresMouseEvents = true }
        watchWorld()
        webView.reload()
    }

    func fit() {
        guard !NSScreen.screens.isEmpty else { return } // all displays gone for a moment (lid closed, reconnecting)
        // Developer hook: CHELIK_FRAME="x,y,w,h" pins the window to a rectangle (for experiments).
        if let f = ProcessInfo.processInfo.environment["CHELIK_FRAME"]?.split(separator: ",").compactMap({ Double($0) }), f.count == 4 {
            panel.setFrame(NSRect(x: f[0], y: f[1], width: f[2], height: f[3]), display: true)
            world.panelFrame = panel.frame
            world.screen = targetScreen
            return
        }
        panel.setFrame(area, display: true)
        lastCursor = CGPoint(x: -1, y: -1)
        world.panelFrame = panel.frame
        world.screen = targetScreen
        world.resend()
    }

    func js(_ code: String) { if ready { web.evaluateJavaScript(code, completionHandler: nil) } }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let body = m.body as? [String: Any], let t = body["t"] as? String else { return }
        switch t {
        case "ready":
            ready = true
            FrameCap.root = web.layer
            acts = body["acts"] as? [String] ?? []
            lastLowPower = nil
            apply()
            world.resend()
            // Developer hook: CHELIK_EVAL="js code" runs once the page is up.
            if let code = ProcessInfo.processInfo.environment["CHELIK_EVAL"] { js(code) }
        case "interactive":
            let on = body["on"] as? Bool ?? false
            if on != interactive { interactive = on; panel.ignoresMouseEvents = !on; if on { cursorMoved() } }
        case "perch":
            perched = body["on"] as? Bool ?? false
            watchWorld()
        case "mood":
            energy = body["e"] as? Double ?? energy
            mood = body["m"] as? Double ?? mood
            uiModel.refresh()
        case "act":
            lastAct = body["n"] as? String ?? ""
            NSLog("chelik act: \(lastAct)")
        case "log":
            NSLog("chelik js: \(body["m"] as? String ?? "")")
        case "snap":
            // Developer hook: with CHELIK_SNAP=/some/folder set, the page can ask for a picture of itself
            // (postMessage({t:"snap", n:"name"})) — a way to check drawing without screen recording access.
            guard let dir = ProcessInfo.processInfo.environment["CHELIK_SNAP"] else { break }
            let name = (body["n"] as? String ?? "snap").filter { $0.isLetter || $0.isNumber || $0 == "-" }
            let cfg = WKSnapshotConfiguration()
            if let r = body["r"] as? [Double], r.count == 4 { cfg.rect = CGRect(x: r[0], y: r[1], width: r[2], height: r[3]) }
            web.takeSnapshot(with: cfg) { image, _ in
                guard let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:]) else { return }
                try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
            }
        default: break
        }
    }

    // MARK: State

    var lowPower: Bool {
        switch settings.power {
        case "on": return true
        case "off": return false
        default: return onBattery() || ProcessInfo.processInfo.isLowPowerModeEnabled
        }
    }

    func onBattery() -> Bool {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() else { return false }
        return (type as String) == "Battery Power"
    }

    /// Push everything to the window and the page. Cheap; called on any change.
    func apply() {
        if shown { if !panel.isVisible { panel.orderFrontRegardless() } } else if panel.isVisible { panel.orderOut(nil) }
        // On every space, full-screen ones too (Claude, WhatsApp, an editor on the whole screen are just apps).
        // He steps aside on his own only for full-screen videos, games and presentations (see checkAutoHide).
        let behavior: NSWindow.CollectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        if panel.collectionBehavior != behavior {
            panel.collectionBehavior = behavior
            if shown { panel.orderFrontRegardless() }
        }
        if !running && interactive { interactive = false; panel.ignoresMouseEvents = true }
        let lp = lowPower
        lastLowPower = lp
        // 60 frames a second normally, 30 when saving power. (Developer hook: CHELIK_FPS=n, 0 = uncapped.)
        FrameCap.fps = ProcessInfo.processInfo.environment["CHELIK_FPS"].flatMap { Float($0) } ?? (lp ? 30 : 60)
        let act = [0.5, 1, 1.8][max(0, min(2, settings.activity))]
        let traits = "{activity:\(act),chatty:\(max(0, min(2, settings.chatty))),breaks:\(settings.breaks),nightSleep:\(settings.nightSleep),follow:\(settings.follow)}"
        js("desk.state({size:\(settings.size),lowPower:\(lp),running:\(running),lang:'\(settings.lang == "ru" ? "ru" : "en")',traits:\(traits)})")
        watchCursor(running)
        watchWorld()
        status?.button?.appearsDisabled = !running
        status?.isVisible = settings.menuIcon
        // Watch for videos / full screen every 2 s while he is meant to be out (cheap: two system queries).
        let watch = settings.visible && (settings.hideVideo || settings.hideFullScreen || settings.hideCapture)
        if watch, autoTimer == nil {
            let t = Timer(timeInterval: 2, repeats: true) { [weak self] _ in self?.checkAutoHide() }
            t.tolerance = 0.5
            RunLoop.main.add(t, forMode: .common)
            autoTimer = t
        } else if !watch, autoTimer != nil {
            autoTimer?.invalidate()
            autoTimer = nil
        }
        // Switching a reason off brings him back right away instead of after the next quiet spell.
        let stale = (autoHidden == "video" && !settings.hideVideo) || (autoHidden == "fullscreen" && !settings.hideFullScreen)
            || (autoHidden == "capture" && !settings.hideCapture)
        if autoHidden != nil, !watch || stale { autoHidden = nil; clearSince = nil; apply(); return }
        uiModel.refresh()
    }

    func checkAutoHide() {
        guard settings.visible, !systemPaused, !NSScreen.screens.isEmpty else { return }
        var why: String?
        // Recording or sharing the screen decides on its own: hide from it, or stay out for the demo even
        // though recorders and calls look like a playing video (they keep the display awake too).
        if AutoHide.capturing() { why = settings.hideCapture ? "capture" : nil }
        else if settings.hideVideo, AutoHide.videoPlaying() { why = "video" }
        else if settings.hideFullScreen, AutoHide.frontIsFullScreenShow(on: targetScreen) { why = "fullscreen" }
        if let why {
            clearSince = nil
            if why != autoHidden { NSLog("chelik autohide: \(why)"); autoHidden = why; apply() }
        } else if autoHidden != nil {
            // Come back only after a few quiet seconds: players drop and re-take their keep-awake request.
            let since = clearSince ?? Date()
            clearSince = since
            if Date().timeIntervalSince(since) >= 6 { NSLog("chelik autohide: none"); autoHidden = nil; clearSince = nil; apply() }
        }
    }

    // MARK: Cursor
    // The panel gets no mouse moves while it lets clicks through. Rather than polling all day, the app sleeps
    // until the mouse really moves (a global monitor: mouse moves need no permission), then follows it 30 times
    // a second until it rests again. A twice-a-second check is the safety net should the monitor ever stay quiet.

    func watchCursor(_ on: Bool) {
        cursorTimer?.invalidate()
        cursorTimer = nil
        // Developer hook: CHELIK_NO_CURSOR=1 leaves the cursor out, so measurements are not skewed by the mouse.
        if on, !noCursor {
            if moveMonitor == nil {
                moveMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]) { [weak self] _ in self?.cursorMoved() }
            }
            if cursorIdleTimer == nil {
                let t = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
                    guard let self, self.cursorTimer == nil else { return }
                    if self.pollCursor() || self.interactive { self.cursorMoved() }
                }
                t.tolerance = 0.2
                RunLoop.main.add(t, forMode: .common)
                cursorIdleTimer = t
            }
            cursorMoved()
        } else {
            if let m = moveMonitor { NSEvent.removeMonitor(m); moveMonitor = nil }
            cursorIdleTimer?.invalidate()
            cursorIdleTimer = nil
        }
    }

    let noCursor = ProcessInfo.processInfo.environment["CHELIK_NO_CURSOR"] != nil

    func cursorMoved() {
        lastMove = Date()
        guard cursorTimer == nil, running, !noCursor else { return }
        let t = Timer(timeInterval: lastLowPower == true ? 1.0 / 15 : 1.0 / 30, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.pollCursor() { self.lastMove = Date() }
            // While he is under the cursor the events come to this app, not the monitor: keep following.
            if !self.interactive, Date().timeIntervalSince(self.lastMove) > 0.4 {
                self.cursorTimer?.invalidate()
                self.cursorTimer = nil
            }
        }
        t.tolerance = 0.01
        RunLoop.main.add(t, forMode: .common)
        cursorTimer = t
        pollCursor()
    }

    @discardableResult
    func pollCursor() -> Bool {
        let p = NSEvent.mouseLocation, f = panel.frame
        let pt = CGPoint(x: (p.x - f.minX).rounded(), y: (f.maxY - p.y).rounded())
        if pt == lastCursor { return false }
        lastCursor = pt
        js("desk.cursor(\(Int(pt.x)),\(Int(pt.y)))")
        return true
    }

    // MARK: World (windows, Dock, icons)

    func watchWorld() {
        // His senses (apps, music, power, you being away) work whenever he is out, climbing or not.
        if ready && running && settings.senses { senses.start() } else { senses.stop() }
        guard ready, running, settings.climb else {
            world.run(every: 0)
            if ready { js("desk.world(null)") }
            return
        }
        world.run(every: perched ? 0.1 : (lastLowPower == true ? 2 : 1))
    }

    /// Screen Recording: macOS asks once; after that it can only be switched on in System Settings.
    func askScreen() {
        if !CGRequestScreenCaptureAccess(), let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    func askAccess() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    func toggleVisible() { settings.visible.toggle(); apply() }

    // MARK: Menu bar

    func makeStatusItem() {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let img = NSImage(contentsOf: Bundle.main.resourceURL!.appendingPathComponent("trayTemplate.png"))
        img?.isTemplate = true
        img?.size = NSSize(width: 18, height: 18)
        status.button?.image = img
        status.button?.toolTip = "Акко"
        let menu = NSMenu()
        menu.autoenablesItems = false // or the disabled items (status line, "Пауза" while hidden, tricks) look clickable
        menu.delegate = self
        status.menu = menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let s = settings
        menu.addItem(Item("Акко — \(statusText.lowercased())", enabled: false))
        menu.addItem(.separator())
        menu.addItem(Item("Настройки…", key: ",") { [unowned self] in showSettings() })
        menu.addItem(Item(s.visible ? "Спрятать" : "Показать", key: "m", mods: [.command, .option, .shift]) { [unowned self] in toggleVisible() })
        menu.addItem(Item("Пауза", key: "p", on: s.paused, enabled: s.visible) { [unowned self] in settings.paused.toggle(); apply() })

        let tricks = NSMenu()
        tricks.autoenablesItems = false
        let names = actNames.filter { acts.isEmpty || acts.contains($0.0) }
        tricks.addItem(Item("Случайный") { [unowned self] in play(nil) })
        tricks.addItem(.separator())
        for (n, label) in names { tricks.addItem(Item(label) { [unowned self] in play(n) }) }
        let trickItem = Item("Сделать трюк", enabled: running)
        trickItem.submenu = tricks
        menu.addItem(trickItem)
        menu.addItem(.separator())

        let sizes = NSMenu()
        for (v, l) in [(32, "Маленький"), (44, "Обычный"), (60, "Большой"), (84, "Огромный")] {
            sizes.addItem(Item(l, on: s.size == v) { [unowned self] in settings.size = v; apply() })
        }
        let sizeItem = Item("Размер")
        sizeItem.submenu = sizes
        menu.addItem(sizeItem)

        let power = NSMenu()
        for (v, l) in [("auto", "Авто (на батарее)"), ("on", "Всегда"), ("off", "Выключена")] {
            power.addItem(Item(l, on: s.power == v) { [unowned self] in settings.power = v; apply() })
        }
        let powerItem = Item("Экономия энергии")
        powerItem.submenu = power
        menu.addItem(powerItem)

        if NSScreen.screens.count > 1 {
            let screens = NSMenu()
            let current = App.screenID(targetScreen)
            for sc in NSScreen.screens {
                let id = App.screenID(sc)
                screens.addItem(Item(sc.localizedName, on: id == current) { [unowned self] in settings.screenID = id; fit(); apply() })
            }
            let scItem = Item("Экран")
            scItem.submenu = screens
            menu.addItem(scItem)
        }

        let login = SMAppService.mainApp
        menu.addItem(Item("Запускать при входе", on: login.status == .enabled) { [unowned self] in
            setLaunchAtLogin(login.status != .enabled)
        })
        menu.addItem(.separator())
        if !lastAct.isEmpty, running {
            let label = actNames.first { $0.0 == lastAct }?.1 ?? lastAct
            menu.addItem(Item("Сейчас: \(label)", enabled: false))
        }
        menu.addItem(Item("Выйти", key: "q") { NSApp.terminate(nil) })
    }

    // MARK: Global shortcut ⌘⌥⇧M (Carbon hot keys need no accessibility permission)

    func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { App.shared.toggleVisible() }
            return noErr
        }, 1, &spec, nil, nil)
        let id = EventHotKeyID(signature: OSType(0x4D43_484B), id: 1)
        RegisterEventHotKey(UInt32(kVK_ANSI_M), UInt32(cmdKey | optionKey | shiftKey), id, GetApplicationEventTarget(), 0, &hotKey)
    }

    // MARK: System: screens, sleep, lock, power

    func observeSystem() {
        let nc = NotificationCenter.default, ws = NSWorkspace.shared.notificationCenter, dc = DistributedNotificationCenter.default()
        nc.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [unowned self] _ in fit() }
        let pause: (String) -> (Notification) -> Void = { why in { [unowned self] _ in
            if pauseReasons.insert(why).inserted { apply() }
        } }
        let resume: (String) -> (Notification) -> Void = { why in { [unowned self] _ in
            if pauseReasons.remove(why) != nil { apply() }
        } }
        ws.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main, using: pause("sleep"))
        ws.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main, using: pause("sleep"))
        ws.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main, using: resume("sleep"))
        ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main, using: resume("sleep"))
        ws.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: .main, using: pause("session"))
        ws.addObserver(forName: NSWorkspace.sessionDidBecomeActiveNotification, object: nil, queue: .main, using: resume("session"))
        dc.addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main, using: pause("lock"))
        dc.addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main, using: resume("lock"))
        // Switching apps or spaces: check right away instead of waiting for the next tick.
        ws.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [unowned self] _ in checkAutoHide() }
        ws.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [unowned self] _ in checkAutoHide() }
        nc.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { [unowned self] _ in apply() }
        // Plugging in / unplugging: a cheap check twice a minute, acting only on a change.
        let t = Timer(timeInterval: 30, repeats: true) { [unowned self] _ in if lowPower != lastLowPower { apply() } }
        t.tolerance = 5
        RunLoop.main.add(t, forMode: .common)
        powerTimer = t
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory) // menu bar only, no Dock icon
app.run()
