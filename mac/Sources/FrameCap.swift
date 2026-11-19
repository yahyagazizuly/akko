// The frame rate of his animations.
//
// His motion is played by Core Animation: WebKit builds real CALayers in this process and attaches a CAAnimation
// for every move. While any animation is running, the system compositor (WindowServer) redraws the screen at the
// display's full rate, which on a 120 Hz screen costs it about 15% of a core just for him. A little guy does not
// need 120 frames a second, so every animation added in this app is told the rate we want — the compositor then
// only works that often. (`preferredFrameRateRange` is public API; the hook is on `-[CALayer addAnimation:forKey:]`.)

import AppKit
import ObjectiveC

enum FrameCap {
    /// Frames per second for animations; 0 leaves them alone.
    static var fps: Float = 60
    /// Only animations inside this layer (his web view) are touched: the settings window, menus and tooltips are
    /// left exactly as the system made them.
    static weak var root: CALayer?
    /// How many animations were capped / left alone (shown by the CHELIK_CAPLOG developer hook).
    static var capped = 0, skipped = 0
    private static var installed = false

    static func install() {
        guard !installed,
              let a = class_getInstanceMethod(CALayer.self, #selector(CALayer.add(_:forKey:))),
              let b = class_getInstanceMethod(CALayer.self, #selector(CALayer.chelik_add(_:forKey:))) else { return }
        method_exchangeImplementations(a, b)
        installed = true
    }
}

extension CALayer {
    @objc dynamic func chelik_add(_ anim: CAAnimation, forKey key: String?) {
        guard FrameCap.fps > 0, let root = FrameCap.root, isInside(root) else { FrameCap.skipped += 1; return chelik_add(anim, forKey: key) } // the original
        FrameCap.capped += 1
        // A copy: the caller may share its animation object, so it is never changed in place.
        let a = (anim.copy() as? CAAnimation) ?? anim
        a.preferredFrameRateRange = CAFrameRateRange(minimum: min(30, FrameCap.fps), maximum: FrameCap.fps, preferred: FrameCap.fps)
        chelik_add(a, forKey: key)
    }

    private func isInside(_ root: CALayer) -> Bool {
        var l: CALayer? = self
        for _ in 0..<64 {
            guard let x = l else { return false }
            if x === root { return true }
            l = x.superlayer
        }
        return false
    }
}
