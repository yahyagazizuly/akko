// What the desktop looks like to him: the Dock, the windows (front to back) and, with Accessibility access,
// the desktop icons, as rectangles in the overlay's page coordinates. Sent to the page only when something changed.
//
// Window bounds come from the window server and need no permission. The Dock's exact width and the desktop
// icons need Accessibility; without it the Dock's width is worked out from its settings.

import AppKit

final class World {
    /// Called with the new picture as JSON: {"b":[[id, kind, x, y, w, h, on], ...]}, kind 0 window, 1 icon, 2 dock,
    /// 3 ledge (the top edge of something drawn on screen; `on` is the id of the window it is drawn in, 0 for none).
    var onChange: ((String) -> Void)?
    /// Called with an event for desk.sense() as JSON: a new window opened, a notification banner, a screenshot.
    var onSense: ((String) -> Void)?
    /// Where the overlay is (Cocoa coordinates) and which screen it is on.
    var panelFrame = NSRect.zero
    var screen: NSScreen?

    private var timer: Timer?
    private var interval: TimeInterval = 0
    private var last = ""
    private var icons: [CGRect] = []
    private var axDockRect: CGRect?
    private var axAt = Date.distantPast
    private var axBusy = false
    private let me = ProcessInfo.processInfo.processIdentifier
    /// Ledges already given an id: which window they are in and where in it, so they keep their id between looks.
    private var known: [(id: Int, owner: Int, rel: CGRect)] = []
    private var nextLedge = -3000
    /// Windows seen on the last look (to notice new ones), and the kind of app of each one's owner, by process.
    private var lastIDs: Set<Int>?
    private var kinds: [Int32: String] = [:]
    private var bundles: [Int32: String?] = [:]
    /// Accessibility access and the Dock's settings, asked at most every few seconds (he looks up to 10 times a second).
    private var trustedNow = false, trustedAt = Date.distantPast
    private var dockAutohide = false, dockGuess: CGRect?, dockAt = Date.distantPast
    /// His eyes (with Screen Recording permission): visible window edges, the real Dock, the desktop icons.
    let sight = Sight()

    // Only while looking: a late answer from his eyes must not start new looks while he is stopped.
    init() { sight.onUpdate = { [weak self] in if self?.timer != nil { self?.look() } } }

    /// Look every `every` seconds (0 stops). Looking costs well under a millisecond.
    func run(every: TimeInterval) {
        if every == interval, timer != nil || every == 0 { return }
        timer?.invalidate()
        timer = nil
        interval = every
        guard every > 0 else { last = ""; lastIDs = nil; return }
        let t = Timer(timeInterval: every, repeats: true) { [weak self] _ in self?.look() }
        t.tolerance = every * 0.2
        RunLoop.main.add(t, forMode: .common)
        timer = t
        look()
    }

    /// Forget what was sent, so the next look sends it again (after a page reload).
    func resend() { last = ""; dockAt = .distantPast; look() }

    /// The app's bundle id, by process (owner names of windows are localized: "Центр уведомлений", not "Notification Center").
    private func bundle(_ pid: Int32) -> String? {
        if let b = bundles[pid] { return b }
        let b = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
        bundles[pid] = b
        return b
    }

    func look() {
        let json = picture()
        if json != last { last = json; onChange?(json) }
    }

    // MARK: Building the picture

    /// Global window-server coordinates (top-left of the main screen is 0,0) to page coordinates.
    func page(_ r: CGRect) -> CGRect {
        let mainH = NSScreen.screens.first?.frame.height ?? 0
        return CGRect(x: r.minX - panelFrame.minX, y: r.minY - (mainH - panelFrame.maxY), width: r.width, height: r.height)
    }

    private func picture() -> String {
        var out: [[Int]] = []
        let bounds = CGRect(origin: .zero, size: panelFrame.size)
        let add = { (id: Int, kind: Int, r: CGRect, on: Int) in
            let p = self.page(r)
            guard p.intersects(bounds) else { return }
            out.append([id, kind, Int(p.minX.rounded()), Int(p.minY.rounded()), Int(p.width.rounded()), Int(p.height.rounded()), on])
        }
        var seen: [(id: Int, rect: CGRect)] = []
        var dockShown = false
        // Every window that can hold a ledge, front to back: normal windows, and menus / pop-ups (floating).
        var owners: [(id: Int, rect: CGRect, floating: Bool)] = []
        var ids = Set<Int>(), apps: [String: String] = [:], news: [[String: Any]] = []
        let fresh = { (id: Int) in self.lastIDs != nil && !self.lastIDs!.contains(id) }
        // Windows, front to back.
        if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
            let dockLevel = Int(CGWindowLevelForKey(.dockWindow))
            for w in list {
                // The Dock's bar is on screen only while its window at the Dock level is (not in a full-screen space).
                let layer = w[kCGWindowLayer as String] as? Int ?? 0
                let ownerName = w[kCGWindowOwnerName as String] as? String ?? ""
                let ownerPID = w[kCGWindowOwnerPID as String] as? Int32 ?? 0
                // Only windows above the normal ones need their app named here (a cached lookup by process).
                let ownerBundle = layer != 0 ? bundle(ownerPID) ?? "" : ""
                if let wid = w[kCGWindowNumber as String] as? Int, let b = w[kCGWindowBounds as String] as? [String: Double] {
                    ids.insert(wid)
                    let r = page(CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0))
                    // A notification banner, or the screenshot tool, just showed up.
                    if fresh(wid), layer > 0, ownerBundle == "com.apple.notificationcenterui" || ownerName.contains("Notification"),
                       r.width >= 200, r.width <= 700, r.height >= 40, r.height <= 400, r.intersects(bounds) {
                        news.append(["t": "notify", "x": Int(r.minX), "y": Int(r.minY), "w": Int(r.width), "h": Int(r.height)])
                    }
                    if fresh(wid), ownerBundle == "com.apple.screencaptureui" || ownerName == "Screenshot" || ownerName == "screencaptureui" { news.append(["t": "shot"]) }
                }
                if layer == dockLevel, ownerBundle == "com.apple.dock" || ownerName == "Dock" { dockShown = true }
                // Menus and pop-ups (above the windows, below the screen saver): things he can stand on too.
                if layer > 0, layer < 500, layer != dockLevel, (w[kCGWindowOwnerPID as String] as? Int32) != me,
                   (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.1,
                   ownerName != "Window Server",
                   !["com.apple.dock", "com.apple.controlcenter", "com.apple.systemuiserver"].contains(ownerBundle),
                   let b = w[kCGWindowBounds as String] as? [String: Double], let id = w[kCGWindowNumber as String] as? Int {
                    let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
                    if r.width >= 60, r.height >= 30 { owners.append((id, r, true)) }
                }
                if out.count >= 40 { continue }
                guard (w[kCGWindowLayer as String] as? Int) == 0,
                      (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.1,
                      let b = w[kCGWindowBounds as String] as? [String: Double],
                      let id = w[kCGWindowNumber as String] as? Int else { continue }
                let owner = w[kCGWindowOwnerName as String] as? String ?? ""
                if owner == "Window Server" || owner == "Dock" { continue }
                let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
                if r.width < 100 || r.height < 50 { continue }
                seen.append((id, r))
                owners.append((id, r, false))
                if let pid = w[kCGWindowOwnerPID as String] as? Int32 {
                    let k = kinds[pid] ?? Senses.kind(NSRunningApplication(processIdentifier: pid)?.bundleIdentifier)
                    kinds[pid] = k
                    apps[String(id)] = k
                    // A new, real window (not a little panel) opened.
                    let p = page(r)
                    if fresh(id), r.width >= 300, r.height >= 200, p.intersects(bounds) {
                        news.append(["t": "window", "c": k, "id": id, "x": Int(p.minX), "y": Int(p.minY), "w": Int(p.width), "h": Int(p.height)])
                    }
                }
                // The visible window, if his eyes have measured it (bounds can include an invisible margin).
                if let i = sight.insets[Sight.key(id, r)], i.top + i.side * 2 < min(r.width, r.height) / 2 {
                    add(id, 0, CGRect(x: r.minX + i.side, y: r.minY + i.top, width: r.width - i.side * 2, height: r.height - i.top - i.side), 0)
                } else {
                    // Not measured (no Screen Recording, or not yet): what his eyes measured for this app before
                    // (kept across launches and updates), else the macOS 26 guess.
                    let pid = w[kCGWindowOwnerPID as String] as? Int32 ?? 0
                    let i = Sight.remembered(bundles[pid] ?? { let b = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier; bundles[pid] = b; return b }()) ?? Sight.guess
                    add(id, 0, CGRect(x: r.minX + i.side, y: r.minY + i.top, width: r.width - i.side * 2, height: r.height - i.top - i.side), 0)
                }
            }
        }
        // Only once things have settled (a first look, or a space switch, shows many windows at once).
        if news.count <= 2 { for n in news { onSense?(Senses.json(n)) } }
        lastIDs = ids
        if kinds.count > 200 { kinds = [:]; bundles = [:] }
        let mainH = NSScreen.screens.first?.frame.height ?? 0
        sight.look(windows: seen, near: screen.map { CGRect(x: $0.frame.minX, y: mainH - $0.frame.maxY, width: $0.frame.width, height: $0.frame.height) })
        if let n = screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
            sight.lookForLedges(display: CGDirectDisplayID(n.uint32Value), windows: owners, every: max(2, interval * 2))
        }
        let eyes = Sight.allowed
        if Date().timeIntervalSince(trustedAt) > 2 { trustedNow = AXIsProcessTrusted(); trustedAt = Date() }
        let trusted = trustedNow
        if trusted {
            // Asking Finder and the Dock goes through Accessibility, which can stall on a busy Finder: do it off
            // the main thread every few seconds and use the last answer meanwhile.
            if !axBusy, Date().timeIntervalSince(axAt) > 6 {
                axBusy = true
                DispatchQueue.global(qos: .utility).async {
                    let found = World.desktopIcons(), dock = World.axDock()
                    DispatchQueue.main.async { self.icons = found; self.axDockRect = dock; self.axAt = Date(); self.axBusy = false; self.look() }
                }
            }
            if !(eyes && sight.iconsSeen) { for (i, r) in icons.enumerated() { add(-1 - i, 1, r, 0) } }
        } else if !icons.isEmpty || axDockRect != nil {
            icons = []
            axDockRect = nil
        }
        readDock()
        var taken: [CGRect] = []
        let iconRects = eyes && sight.iconsSeen ? sight.icons : (trusted ? icons : [])
        if eyes && sight.iconsSeen { for (i, r) in sight.icons.enumerated() { add(-1 - i, 1, r, 0) } }
        taken += iconRects
        // The Dock, only while it really is on screen (a full-screen app hides it whatever its settings say).
        // His eyes look every 20 s, so a Dock that hides itself may have been caught while shown: trust the setting.
        let dockRect: CGRect? = !dockShown ? nil : (eyes && sight.dockSeen ? (dockAutohide ? nil : sight.dock) : dock(exact: trusted))
        if let d = dockRect { add(-1000, 2, d, 0); taken.append(d.insetBy(dx: -10, dy: -20)) }
        if eyes { addLedges(windows: owners, taken: taken) { id, r, on in add(id, 3, r, on) } }
        return "{\"b\":" + "[" + out.map { "[" + $0.map(String.init).joined(separator: ",") + "]" }.joined(separator: ",") + "],\"a\":" + Senses.json(apps) + "}"
    }

    // MARK: Ledges

    /// The ledges his eyes found, moved along with their windows since (a window that changed size is left out
    /// until he looks again; a window that went away takes its ledges with it).
    private func addLedges(windows: [(id: Int, rect: CGRect, floating: Bool)], taken: [CGRect], add: (Int, CGRect, Int) -> Void) {
        var now: [(id: Int, owner: Int, rel: CGRect)] = []
        for l in sight.ledges {
            var r = l.rect
            if l.owner != 0 {
                guard let w = windows.first(where: { $0.id == l.owner }),
                      abs(w.rect.width - l.ownerRect.width) < 2, abs(w.rect.height - l.ownerRect.height) < 2 else { continue }
                r = r.offsetBy(dx: w.rect.minX - l.ownerRect.minX, dy: w.rect.minY - l.ownerRect.minY)
            }
            if taken.contains(where: { $0.intersects(r) }) { continue }
            // Keep the id it had: same window, about the same place in it.
            let rel = l.owner != 0 ? l.rect.offsetBy(dx: -l.ownerRect.minX, dy: -l.ownerRect.minY) : l.rect
            let id = known.first { k in k.owner == l.owner && abs(k.rel.minY - rel.minY) <= 4 && k.rel.minX < rel.maxX && rel.minX < k.rel.maxX
                && !now.contains(where: { $0.id == k.id }) }?.id ?? { nextLedge -= 1; return nextLedge }()
            now.append((id, l.owner, rel))
            add(id, r, l.floating ? -1 : l.owner)
        }
        known = now
    }

    // MARK: The Dock

    /// The Dock's bar, when it sits along the bottom of this screen and does not hide itself.
    private func dock(exact: Bool) -> CGRect? {
        if dockAutohide { return nil }
        if exact, axDockRect != nil, let screen, screen.visibleFrame.minY - screen.frame.minY > 20 { return axDockRect }
        return dockGuess
    }

    /// The Dock's settings and the estimate of its bar, worked out again every few seconds.
    private func readDock() {
        guard Date().timeIntervalSince(dockAt) > 3 else { return }
        dockAt = Date()
        let prefs = UserDefaults(suiteName: "com.apple.dock")
        dockAutohide = prefs?.bool(forKey: "autohide") == true
        dockGuess = estimateDock(prefs)
    }

    private func estimateDock(_ prefs: UserDefaults?) -> CGRect? {
        guard let screen else { return nil }
        if prefs?.bool(forKey: "autohide") == true { return nil }
        if let o = prefs?.string(forKey: "orientation"), o != "bottom" { return nil }
        let reserved = screen.visibleFrame.minY - screen.frame.minY
        guard reserved > 20 else { return nil } // the Dock is on another screen
        let mainH = NSScreen.screens.first?.frame.height ?? 0
        let bottom = mainH - screen.frame.minY // global y of this screen's bottom edge
        // Without Accessibility: as many tiles as it shows, each a little wider than the icon size.
        let tile = max(16, prefs?.double(forKey: "tilesize") ?? 48)
        let apps = (prefs?.array(forKey: "persistent-apps") as? [[String: Any]]) ?? []
        let others = (prefs?.array(forKey: "persistent-others") as? [[String: Any]])?.count ?? 0
        let showRecents = prefs?.object(forKey: "show-recents") as? Bool ?? true
        let kept = Set(apps.compactMap { (($0["tile-data"] as? [String: Any])?["file-data"] as? [String: Any])?["_CFURLString"] as? String }
            .compactMap { URL(string: $0)?.standardizedFileURL.path })
        let running = NSWorkspace.shared.runningApplications.filter {
            $0.activationPolicy == .regular && $0.bundleIdentifier != "com.apple.finder" && !kept.contains($0.bundleURL?.standardizedFileURL.path ?? "")
        }.count
        let recents = showRecents ? max(running, (prefs?.array(forKey: "recent-apps"))?.count ?? 0) : running
        let tiles = 1 + apps.count + recents + others + 1 // Finder … Trash
        let seps = 1 + (recents > 0 ? 1 : 0)
        let width = min(screen.frame.width - 8, Double(tiles) * tile * 1.1 + Double(seps) * 10 + 12)
        let height = reserved - 4
        return CGRect(x: screen.frame.midX - width / 2, y: bottom - height - 2, width: width, height: height)
    }

    // MARK: Accessibility (optional)

    private static func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
        var v: AnyObject?
        return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
    }

    private static func frame(_ e: AXUIElement) -> CGRect? {
        guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute) else { return nil }
        guard CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var pt = CGPoint.zero, sz = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
        return CGRect(origin: pt, size: sz)
    }

    private static func app(_ bundle: String) -> AXUIElement? {
        guard let a = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first else { return nil }
        let e = AXUIElementCreateApplication(a.processIdentifier)
        AXUIElementSetMessagingTimeout(e, 0.25)
        return e
    }

    private static func kids(_ e: AXUIElement) -> [AXUIElement] { attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? [] }

    /// The Dock's bar: its one list of tiles.
    static func axDock() -> CGRect? {
        guard let dock = app("com.apple.dock") else { return nil }
        for k in kids(dock) where (attr(k, kAXRoleAttribute) as? String) == kAXListRole {
            if let r = frame(k), r.width > 50 { return r }
        }
        return nil
    }

    /// The icons on the desktop (Finder's desktop is a scroll area of images), without their labels.
    static func desktopIcons() -> [CGRect] {
        guard let finder = app("com.apple.finder") else { return [] }
        var out: [CGRect] = []
        func walk(_ e: AXUIElement, _ depth: Int) {
            if out.count >= 60 { return }
            let role = attr(e, kAXRoleAttribute) as? String ?? ""
            if role == kAXImageRole, let r = frame(e), r.width >= 16, r.width <= 260, r.height >= 16, r.height <= 260 { out.append(r); return }
            if depth >= 4 || role == kAXWindowRole { return } // Finder windows are not the desktop
            for k in kids(e) { walk(k, depth + 1) }
        }
        for k in kids(finder) where (attr(k, kAXRoleAttribute) as? String) == kAXScrollAreaRole { walk(k, 1) }
        return out
    }
}
