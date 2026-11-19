// When to step aside on his own: while a video plays (or a call is on) and while an app is full screen.
// Both checks need no permissions: video players ask the system to keep the display awake, and window
// sizes are public even without screen recording access.

import AppKit
import IOKit.pwr_mgt

enum AutoHide {
    /// Display-keep-awake requests from other apps: browsers and players make one while a video plays, call apps during a call.
    static func videoPlaying() -> Bool {
        var out: Unmanaged<CFDictionary>?
        guard IOPMCopyAssertionsByProcess(&out) == kIOReturnSuccess,
              let byPID = out?.takeRetainedValue() as? [NSNumber: [[String: Any]]] else { return false }
        let me = ProcessInfo.processInfo.processIdentifier
        let types: Set<String> = ["PreventUserIdleDisplaySleep", "NoDisplaySleepAssertion"]
        // System daemons and keep-awake utilities (caffeinate, Amphetamine…) hold these all day without any video:
        // counting them would keep him hidden for good.
        let systemOwners: Set<String> = ["powerd", "WindowServer", "loginwindow", "caffeinate", "Amphetamine",
                                         "KeepingYouAwake", "Lungo", "Theine", "Caffeine"]
        for (pid, list) in byPID where pid.int32Value != me {
            for a in list {
                guard let type = a["AssertType"] as? String, types.contains(type) else { continue }
                // A request that exists but is switched off (level 0) keeps nothing awake.
                if let level = a["AssertLevel"] as? Int, level == 0 { continue }
                if let name = a["Process Name"] as? String, systemOwners.contains(name) { continue }
                return true
            }
        }
        return false
    }

    /// The screen is being recorded or shown: the Cmd+Shift+5 / QuickTime recording toolbar, OBS, Kap, or Zoom's
    /// screen-share helper. These run only while capturing (the screenshot toolbar also for a moment per screenshot).
    /// Sharing from a browser tab (Google Meet) or other call apps is not visible from outside.
    static func capturing() -> Bool {
        let names: Set<String> = ["screencaptureui", "obs", "kap", "cpthost", "aomhost", "screen studio"]
        return NSWorkspace.shared.runningApplications.contains { app in
            guard let exe = app.executableURL?.lastPathComponent.lowercased() else { return false }
            return names.contains(exe)
        }
    }

    /// A game, a presentation or a video player fills this screen. Other apps on the whole screen (a chat, an
    /// editor, a browser) are no reason to hide: he keeps them company. (Videos in a browser are caught by
    /// videoPlaying.)
    static func frontIsFullScreenShow(on screen: NSScreen) -> Bool {
        guard let front = NSWorkspace.shared.frontmostApplication, frontIsFullScreen(on: screen) else { return false }
        let b = (front.bundleIdentifier ?? "").lowercased()
        if Senses.kind(front.bundleIdentifier) == "video" { return true }
        if ["keynote", "powerpoint", "com.apple.iwork.keynote", "pitch", "prezi"].contains(where: { b.contains($0) }) { return true }
        let category = front.bundleURL.flatMap { Bundle(url: $0)?.infoDictionary?["LSApplicationCategoryType"] as? String } ?? ""
        return category.contains("games")
    }

    /// The app in front has a window covering the whole of this screen (native full screen or a borderless player).
    static func frontIsFullScreen(on screen: NSScreen) -> Bool {
        guard let front = NSWorkspace.shared.frontmostApplication,
              front.processIdentifier != ProcessInfo.processInfo.processIdentifier,
              front.bundleIdentifier != "com.apple.finder",
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return false }
        // Window bounds are in top-left-origin global coordinates; convert the screen frame to match.
        let primaryH = NSScreen.screens.first?.frame.height ?? screen.frame.height
        let f = screen.frame
        let target = CGRect(x: f.minX, y: primaryH - f.maxY, width: f.width, height: f.height)
        for w in windows {
            guard (w[kCGWindowOwnerPID as String] as? Int32) == front.processIdentifier,
                  (w[kCGWindowLayer as String] as? Int) == 0,
                  let dict = w[kCGWindowBounds as String] as? NSDictionary,
                  let b = CGRect(dictionaryRepresentation: dict as CFDictionary) else { continue }
            // The whole screen, or all of it below a menu bar left showing (native full screen on notched Macs).
            if abs(b.minX - target.minX) < 2, abs(b.width - target.width) < 2,
               b.minY - target.minY < 40, abs(b.maxY - target.maxY) < 2 { return true }
        }
        return false
    }
}
