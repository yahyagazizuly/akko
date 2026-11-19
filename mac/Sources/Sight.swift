// His eyes: with Screen Recording permission he looks at the screen to learn what the window server's numbers
// do not say, on any Mac and any macOS version:
//   - where each window's visible edges really are (window bounds can include an invisible margin),
//   - the Dock's real bar (size, position, magnification, hidden or not),
//   - where the desktop icons are (Finder's desktop is a window holding only the icons).
// Only the transparency of these pictures is read, in memory, and thrown away at once; nothing is kept or sent.
// Without the permission World falls back to estimates.

import AppKit
import ScreenCaptureKit

final class Sight {
    /// Asked of the system at most every 2 s (World looks up to 10 times a second).
    static var allowed: Bool {
        if Date().timeIntervalSince(allowedAt) > 2 { allowedNow = CGPreflightScreenCaptureAccess(); allowedAt = Date() }
        return allowedNow
    }
    private static var allowedNow = false
    private static var allowedAt = Date.distantPast

    /// Called on the main thread when something new was learned.
    var onUpdate: (() -> Void)?
    /// Visible-edge insets per window ("id w h"): top, side (left = right = bottom).
    private(set) var insets: [String: (top: CGFloat, side: CGFloat)] = [:]
    /// In window-server coordinates (top-left of the main screen is 0,0).
    private(set) var dock: CGRect?
    private(set) var dockSeen = false
    private(set) var icons: [CGRect] = []
    private(set) var iconsSeen = false

    /// Ledges seen on the screen itself (the top edge of anything drawn: an input box, a pop-up menu, a panel),
    /// in window-server coordinates, each with the window it was drawn in and where that window was then.
    private(set) var ledges: [Ledge] = []
    struct Ledge { let rect: CGRect; let owner: Int; let ownerRect: CGRect; let floating: Bool }

    private var asking = Set<String>()
    /// Windows whose picture could not be taken (or showed nothing), and when: tried again a minute later.
    private var failed: [String: Date] = [:]
    private var scanning = false
    private var scannedAt = Date.distantPast
    private var ledgeBusy = false
    private var ledgeAt = Date.distantPast

    static func key(_ id: Int, _ r: CGRect) -> String { "\(id) \(Int(r.width)) \(Int(r.height))" }

    /// The visible edges last measured for an app's windows, kept across launches and updates: an app draws all
    /// its windows the same way, so this stands in until (or when) a window cannot be measured — for example after
    /// an update, before Screen Recording is allowed again.
    static func remembered(_ bundle: String?) -> (top: CGFloat, side: CGFloat)? {
        guard let bundle, let v = UserDefaults.standard.array(forKey: "inset." + bundle) as? [Double], v.count == 2 else { return nil }
        return floored((CGFloat(v[0]), CGFloat(v[1])))
    }
    /// On macOS 26 a window's picture starts with a strip the screen never shows (~8 pt: measured 0 on Finder and
    /// WhatsApp, which made him stand that much too high), so the visible top is never above that.
    static func floored(_ i: (top: CGFloat, side: CGFloat)) -> (top: CGFloat, side: CGFloat) { (max(i.top, guess.top), i.side) }
    static func remember(_ bundle: String?, _ i: (top: CGFloat, side: CGFloat)) {
        guard let bundle else { return }
        UserDefaults.standard.set([Double(i.top), Double(i.side)], forKey: "inset." + bundle)
    }
    /// When nothing is known about an app: on macOS 26 a window's visible top sits ~8 pt below its bounds.
    static var guess: (top: CGFloat, side: CGFloat) { (ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26 ? 8 : 0, 0) }

    /// A line in ~/Library/Logs/Akko.log (what he measured, to check his eyes; a few lines per new window).
    static func log(_ s: String) {
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Akko.log")
        let line = "\(Date()) \(s)\n"
        if let h = try? FileHandle(forWritingTo: url) {
            defer { try? h.close() }
            if (try? h.seekToEnd()) ?? 0 > 200_000 { try? h.truncate(atOffset: 0) }
            h.write(Data(line.utf8))
        } else { try? Data(line.utf8).write(to: url) }
    }

    /// Measure windows not seen yet, and every 20 s look at the Dock and the desktop again.
    /// `near` is the overlay's screen (window-server coordinates): with several displays, its desktop is the one looked at.
    func look(windows: [(id: Int, rect: CGRect)], near: CGRect? = nil) {
        guard #available(macOS 14.0, *), Sight.allowed else { return }
        // Every size a window had gets its own entry (a live resize makes dozens): keep only the windows there now.
        if insets.count > 300 || failed.count > 300 {
            let now = Set(windows.map { Sight.key($0.id, $0.rect) })
            insets = insets.filter { now.contains($0.key) }
            failed = failed.filter { now.contains($0.key) }
        }
        let todo = windows.filter {
            let k = Sight.key($0.id, $0.rect)
            return insets[k] == nil && !asking.contains(k) && Date().timeIntervalSince(failed[k] ?? .distantPast) > 60
        }.prefix(4)
        let scan = !scanning && Date().timeIntervalSince(scannedAt) > 20
        guard !todo.isEmpty || scan else { return }
        for w in todo { asking.insert(Sight.key(w.id, w.rect)) }
        if scan { scanning = true }
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { [weak self] content, _ in
            guard let self, let content else { DispatchQueue.main.async { self?.asking.removeAll(); self?.scanning = false }; return }
            for w in todo {
                let key = Sight.key(w.id, w.rect)
                guard let sw = content.windows.first(where: { Int($0.windowID) == w.id }) else {
                    // Gone, or not capturable: let it be asked again later instead of waiting forever.
                    DispatchQueue.main.async { self.asking.remove(key); self.failed[key] = Date() }
                    continue
                }
                self.measure(sw, key: key)
            }
            if scan {
                // With several displays there is one of each per display: the one on his screen.
                func pick(_ ws: [SCWindow]) -> SCWindow? {
                    guard let near else { return ws.first }
                    return ws.max { a, b in
                        let x = a.frame.intersection(near), y = b.frame.intersection(near)
                        return (x.isNull ? 0 : x.width * x.height) < (y.isNull ? 0 : y.width * y.height)
                    }
                }
                let dockWin = pick(content.windows.filter { $0.owningApplication?.bundleIdentifier == "com.apple.dock" && $0.windowLayer == 20 })
                let deskWin = pick(content.windows.filter { $0.owningApplication?.bundleIdentifier == "com.apple.finder" && $0.windowLayer == Int(CGWindowLevelForKey(.desktopIconWindow)) })
                self.findDock(dockWin)
                self.findIcons(deskWin)
                DispatchQueue.main.async { self.scannedAt = Date(); self.scanning = false }
            }
        }
    }

    // MARK: Ledges: looking at the whole screen

    /// Every `every` seconds, look at what is drawn on this display (without our own overlay) and find the
    /// long horizontal edges in it: things he can stand on, whatever app drew them.
    /// `windows` are the visible windows front to back (menus and pop-ups marked floating), to tell which window
    /// each ledge belongs to.
    func lookForLedges(display: CGDirectDisplayID, windows: [(id: Int, rect: CGRect, floating: Bool)], every: TimeInterval) {
        guard #available(macOS 14.0, *), Sight.allowed, !ledgeBusy, Date().timeIntervalSince(ledgeAt) > every else { return }
        ledgeBusy = true
        let me = ProcessInfo.processInfo.processIdentifier
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { [weak self] content, _ in
            guard let self else { return }
            guard let content, let d = content.displays.first(where: { $0.displayID == display }) else {
                DispatchQueue.main.async { self.ledgeBusy = false; self.ledgeAt = Date() }
                return
            }
            let mine = content.applications.filter { $0.processID == me }
            let filter = SCContentFilter(display: d, excludingApplications: mine, exceptingWindows: [])
            let cfg = SCStreamConfiguration()
            let scale: CGFloat = 0.5
            cfg.width = max(1, Int(CGFloat(d.width) * scale))
            cfg.height = max(1, Int(CGFloat(d.height) * scale))
            cfg.showsCursor = false
            cfg.captureResolution = .nominal
            let origin = d.frame.origin // global, top-left
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { img, _ in
                var found: [Ledge] = []
                if let img {
                    let l = Luma(img)
                    let sx = CGFloat(d.width) / CGFloat(l.w), sy = CGFloat(d.height) / CGFloat(l.h)
                    for r in Sight.edges(l) {
                        let g = CGRect(x: origin.x + CGFloat(r.minX) * sx, y: origin.y + CGFloat(r.minY) * sy,
                                       width: CGFloat(r.width) * sx, height: 4)
                        // The window it is drawn in: the front one under the point just below the edge.
                        let p = CGPoint(x: g.midX, y: g.minY + 3)
                        if let w = windows.first(where: { $0.rect.contains(p) }) {
                            // A window's own top edge is the window itself, not a ledge (a menu's top is one, though).
                            if !w.floating, abs(g.minY - w.rect.minY) < 14 { continue }
                            let c = g.intersection(w.rect)
                            guard c.width >= 40 else { continue }
                            found.append(Ledge(rect: CGRect(x: c.minX, y: g.minY, width: c.width, height: 4), owner: w.id, ownerRect: w.rect, floating: w.floating))
                        } else {
                            found.append(Ledge(rect: g, owner: 0, ownerRect: .zero, floating: false))
                        }
                    }
                }
                DispatchQueue.main.async {
                    if found.count != self.ledges.count { NSLog("chelik sight: \(found.count) ledges") }
                    self.ledges = found
                    self.ledgeBusy = false
                    self.ledgeAt = Date()
                    self.onUpdate?()
                }
            }
        }
    }

    /// Long horizontal edges in a gray picture that have room above them: rows where the brightness changes from
    /// the row above (a step, or a thin line) for a long run, and where nothing is drawn in the space above, as tall
    /// as he is. Lines of text, the bottoms of boxes and separators between menu items have things right above them,
    /// so they are not ledges; the tops of boxes, bars, menus and panels are.
    static func edges(_ l: Luma) -> [CGRect] {
        let w = l.w, h = l.h
        let minRun = 24, room = 18 // picture pixels (half points): ~48 pt long, ~36 pt of free space above
        // Busy pixels: any detail (text, icons, pictures). counts[y * w + x] = busy pixels in column x above row y.
        var counts = [Int32](repeating: 0, count: w * (h + 1))
        for y in 0..<h {
            for x in 0..<w {
                let v = Int(l[x, y])
                let busy = (x > 0 && abs(v - Int(l[x - 1, y])) > 10) || (y > 0 && abs(v - Int(l[x, y - 1])) > 10)
                counts[(y + 1) * w + x] = counts[y * w + x] + (busy ? 1 : 0)
            }
        }
        // Free space above row y at column x (rows y-room ... y-3 hold no detail), and a plain surface just under the
        // edge (rows y+2 ... y+4): the middle of a line of text has letters both above and below.
        func free(_ x: Int, _ y: Int) -> Bool {
            y - room >= 0 && counts[(y - 2) * w + x] == counts[(y - room) * w + x]
                && (y + 5 > h || counts[(y + 5) * w + x] == counts[(y + 2) * w + x])
        }
        var runs: [CGRect] = []
        for y in (room + 1)..<h {
            var start = -1, gap = 0, last = -1
            func close() {
                if start >= 0, last - start + 1 >= minRun { runs.append(CGRect(x: start, y: y, width: last - start + 1, height: 1)) }
                start = -1; gap = 0
            }
            for x in 0..<w {
                let a = Int(l[x, y]), b = Int(l[x, y - 1]), c = Int(l[x, y - 2])
                if (abs(a - b) >= 6 || abs(a - c) >= 7) && free(x, y) {
                    if start < 0 { start = x }
                    last = x; gap = 0
                } else if start >= 0 {
                    gap += 1
                    if gap > 1 { close() }
                }
            }
            close()
            if runs.count > 2000 { break } // a very busy picture: what was found is plenty
        }
        // One edge often shows on two neighbouring rows (a step, then the line under it): keep the upper one.
        runs.sort { $0.minY != $1.minY ? $0.minY < $1.minY : $0.minX < $1.minX }
        var out: [CGRect] = []
        for r in runs {
            if out.contains(where: { abs($0.minY - r.minY) <= 3 && $0.minX < r.maxX && r.minX < $0.maxX }) { continue }
            out.append(r)
        }
        // The bottom of a box sits right under its top: standing there he would stand inside it. Keep the top.
        out = out.filter { r in !out.contains { o in
            o.minY < r.minY - 3 && r.minY - o.minY <= 30 && min(o.maxX, r.maxX) - max(o.minX, r.minX) >= r.width * 0.6
        } }
        // The longest ones (they are the best to stand on), at most 40.
        return Array(out.sorted { $0.width > $1.width }.prefix(40))
    }

    // MARK: Pictures

    @available(macOS 14.0, *)
    private func capture(_ w: SCWindow, rect: CGRect? = nil, scale: CGFloat, done: @escaping (Alpha?) -> Void) {
        let filter = SCContentFilter(desktopIndependentWindow: w)
        let cfg = SCStreamConfiguration()
        let r = rect ?? CGRect(origin: .zero, size: w.frame.size)
        cfg.sourceRect = r
        cfg.width = max(1, Int(r.width * scale))
        cfg.height = max(1, Int(r.height * scale))
        cfg.showsCursor = false
        cfg.ignoreShadowsSingleWindow = true
        cfg.captureResolution = .nominal
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { img, _ in done(img.map { Alpha($0) }) }
    }

    /// The window's top strip: the first solid row is its visible top; a little lower, the first solid column is its side.
    @available(macOS 14.0, *)
    private func measure(_ w: SCWindow, key: String) {
        let h = min(w.frame.height, 90)
        capture(w, rect: CGRect(x: 0, y: 0, width: w.frame.width, height: h), scale: 1) { [weak self] a in
            // Outside the window (shadow left out) nothing is drawn at all, while even a see-through glass toolbar
            // is drawn a little: so "drawn" means any alpha, not "solid". (A solid threshold made glass windows —
            // Finder, WhatsApp on macOS 26 — measure differently depending on whether they were active.)
            func edges(_ a: Alpha, _ t: UInt8) -> (CGFloat, CGFloat)? {
                let x0 = a.w * 3 / 10, x1 = a.w * 7 / 10
                var top = -1
                for y in 0..<min(a.h, 40) {
                    var solid = 0, n = 0
                    for x in stride(from: x0, to: x1, by: 3) { n += 1; if a[x, y] > t { solid += 1 } }
                    if solid * 10 >= n * 8 { top = y; break }
                }
                guard top >= 0 else { return nil }
                // Below the rounded corners (macOS 26 radii reach ~26 pt).
                let row = min(a.h - 1, top + 44)
                var side = 0
                while side < min(30, a.w / 4), a[side, row] <= t { side += 1 }
                return (CGFloat(top), CGFloat(side))
            }
            var found: (CGFloat, CGFloat)?, solid: (CGFloat, CGFloat)?
            if let a, a.w > 40, a.h > 10 { found = edges(a, 6); solid = edges(a, 60) }
            let bundle = w.owningApplication?.bundleIdentifier
            DispatchQueue.main.async {
                guard let self else { return }
                self.asking.remove(key)
                if let f = found {
                    self.insets[key] = Sight.floored((f.0, f.1))
                    Sight.remember(bundle, Sight.floored((f.0, f.1)))
                    self.failed[key] = nil
                } else {
                    // Not stored: World uses what is remembered for the app meanwhile, and it is measured again later.
                    self.failed[key] = Date()
                }
                Sight.log("sight \(bundle ?? "?") \(key): drawn \(found.map { "\($0)" } ?? "none") solid \(solid.map { "\($0)" } ?? "none")")
                self.onUpdate?()
            }
        }
    }

    /// The Dock window covers the screen; only its bar is drawn. Its solid box is the bar.
    @available(macOS 14.0, *)
    private func findDock(_ w: SCWindow?) {
        guard let w else { DispatchQueue.main.async { self.dock = nil; self.dockSeen = true; self.onUpdate?() }; return }
        let scale: CGFloat = 0.5
        capture(w, scale: scale) { [weak self] a in
            // No picture (a failed capture) says nothing about the Dock: keep what was seen before.
            guard let a else { return }
            var box: CGRect?
            do {
                var minX = a.w, minY = a.h, maxX = -1, maxY = -1
                for y in stride(from: 0, to: a.h, by: 2) { for x in stride(from: 0, to: a.w, by: 2) where a[x, y] > 60 {
                    minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
                } }
                // A bar along the bottom: wider than tall and reaching down near the bottom edge.
                if maxX > minX, maxY > minY, maxX - minX > (maxY - minY) * 2, maxY >= a.h - 30 {
                    box = CGRect(x: w.frame.minX + CGFloat(minX) / scale, y: w.frame.minY + CGFloat(minY) / scale,
                                 width: CGFloat(maxX - minX + 2) / scale, height: CGFloat(maxY - minY + 2) / scale)
                }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                if box != self.dock { NSLog("chelik sight: dock \(box.map { "\($0)" } ?? "none")") }
                self.dock = box
                self.dockSeen = true
                self.onUpdate?()
            }
        }
    }

    /// Finder's desktop window holds only the icons and their names: solid blobs, roughly square, are icons.
    @available(macOS 14.0, *)
    private func findIcons(_ w: SCWindow?) {
        guard let w else { DispatchQueue.main.async { self.icons = []; self.iconsSeen = true; self.onUpdate?() }; return }
        let scale: CGFloat = 0.5
        capture(w, scale: scale) { [weak self] a in
            guard let a else { return } // a failed capture: keep the icons seen before
            var found: [CGRect] = []
            do { found = Sight.blobs(a, threshold: 90).compactMap { b -> CGRect? in
                let r = CGRect(x: w.frame.minX + CGFloat(b.minX) / scale, y: w.frame.minY + CGFloat(b.minY) / scale,
                               width: CGFloat(b.width + 1) / scale, height: CGFloat(b.height + 1) / scale)
                let k = r.width / max(1, r.height)
                return r.height >= 28 && r.width >= 24 && r.width <= 260 && k > 0.55 && k < 1.8 ? r : nil
            } }
            DispatchQueue.main.async {
                guard let self else { return }
                if found.count != self.icons.count { NSLog("chelik sight: \(found.count) desktop icons") }
                self.icons = Array(found.prefix(60))
                self.iconsSeen = true
                self.onUpdate?()
            }
        }
    }

    /// Bounding boxes of the solid blobs (4-connected), in picture pixels.
    static func blobs(_ a: Alpha, threshold: UInt8) -> [CGRect] {
        var label = [Int32](repeating: 0, count: a.w * a.h)
        var out: [CGRect] = []
        var stack: [Int] = []
        var next: Int32 = 0
        for start in 0..<(a.w * a.h) where label[start] == 0 && a.data[start] > threshold {
            next += 1
            label[start] = next
            stack.append(start)
            var minX = a.w, minY = a.h, maxX = 0, maxY = 0
            while let p = stack.popLast() {
                let x = p % a.w, y = p / a.w
                minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
                for q in [x > 0 ? p - 1 : -1, x < a.w - 1 ? p + 1 : -1, y > 0 ? p - a.w : -1, y < a.h - 1 ? p + a.w : -1]
                where q >= 0 && label[q] == 0 && a.data[q] > threshold {
                    label[q] = next
                    stack.append(q)
                }
            }
            if maxX - minX >= 6, maxY - minY >= 6 { out.append(CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)) }
            if out.count > 400 { break }
        }
        return out
    }
}

/// Just the brightness of a picture.
struct Luma {
    let w: Int, h: Int
    let data: [UInt8]
    init(_ img: CGImage) {
        let iw = img.width, ih = img.height
        w = iw; h = ih
        var d = [UInt8](repeating: 0, count: iw * ih)
        d.withUnsafeMutableBytes { buf in
            if let ctx = CGContext(data: buf.baseAddress, width: iw, height: ih, bitsPerComponent: 8, bytesPerRow: iw,
                                   space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) {
                ctx.draw(img, in: CGRect(x: 0, y: 0, width: iw, height: ih))
            }
        }
        data = d
    }
    subscript(x: Int, y: Int) -> UInt8 { data[y * w + x] }
}

/// Just the alpha channel of a picture.
struct Alpha {
    let w: Int, h: Int
    let data: [UInt8]
    init(_ img: CGImage) {
        let iw = img.width, ih = img.height
        w = iw; h = ih
        // An RGBA context (alpha-only contexts are picky about color spaces); keep just the alpha bytes.
        var rgba = [UInt8](repeating: 0, count: iw * ih * 4)
        rgba.withUnsafeMutableBytes { buf in
            if let ctx = CGContext(data: buf.baseAddress, width: iw, height: ih, bitsPerComponent: 8, bytesPerRow: iw * 4,
                                   space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
                ctx.draw(img, in: CGRect(x: 0, y: 0, width: iw, height: ih))
            }
        }
        var d = [UInt8](repeating: 0, count: iw * ih)
        for i in 0..<(iw * ih) { d[i] = rgba[i * 4 + 3] }
        data = d
    }
    subscript(x: Int, y: Int) -> UInt8 { x >= 0 && y >= 0 && x < w && y < h ? data[y * w + x] : 0 }
}
