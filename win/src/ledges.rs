// Ledges: the top edges of things drawn inside windows — input boxes, toolbars, tab strips, lists, panels — and
// pop-up menus, for him to stand on (kind 3 in the world picture, as on the Mac).
//
// The Mac finds them by looking at the screen. Windows can simply say: UI Automation (the accessibility API every
// app supports) gives the exact frame of each control, with no permission and without looking at any pixels.
// Only the shape of the app's own controls is read: web pages are not walked into (that would also make browsers
// switch on their whole accessibility machinery), so in a browser he stands on the toolbar and the address bar.
//
// Looking costs a few cross-process calls per control, so a window is walked only when it is new, changed size,
// or every 8 s; in between its ledges move along with it.

#![allow(non_upper_case_globals)] // Windows' own names for control types

use crate::util::Rect;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx};
use windows::Win32::UI::Accessibility::*;
use windows::core::Interface;

/// A visible window, front to back, as the world looker last saw it. `floating`: a pop-up menu.
#[derive(Clone, Copy)]
pub struct Win {
    pub id: isize,
    pub rect: Rect,
    pub floating: bool,
}

/// A ledge in screen pixels, in the window it is drawn in (relative to that window's top-left), so it can follow
/// the window when it moves.
#[derive(Clone, Copy)]
pub struct Ledge {
    pub owner: isize,
    pub rel: Rect,
    pub owner_size: (i32, i32),
    pub floating: bool,
}

#[derive(Default)]
pub struct Shared {
    /// Written by the world looker.
    pub windows: Vec<Win>,
    pub scale: f64,
    pub on: bool,
    /// Written here.
    pub ledges: Vec<Ledge>,
}

pub fn spawn(shared: Arc<Mutex<Shared>>) {
    std::thread::spawn(move || {
        unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
        let Ok(uia) = (unsafe { CoCreateInstance::<_, IUIAutomation>(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) })
            .or_else(|_| unsafe { CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER) })
        else {
            return;
        };
        // A hung app must not hold him up for long.
        if let Ok(u2) = uia.cast::<IUIAutomation2>() {
            unsafe {
                let _ = u2.SetConnectionTimeout(400);
                let _ = u2.SetTransactionTimeout(600);
            }
        }
        let Some(cache) = cache_request(&uia) else { return };
        let Ok(walker) = (unsafe { uia.ControlViewWalker() }) else { return };
        // Per window: its size when walked, when, and what was found.
        let mut seen: HashMap<isize, ((i32, i32), Instant, Vec<Ledge>)> = HashMap::new();
        loop {
            let (windows, scale, on) = {
                let s = shared.lock().unwrap();
                (s.windows.clone(), s.scale, s.on)
            };
            if !on {
                seen.clear();
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
            let mut all: Vec<Ledge> = Vec::new();
            let mut walked = 0;
            // The front few windows are the ones he can reach; menus are cheap (their own top edge).
            for w in windows.iter().take(8) {
                let size = (w.rect.w, w.rect.h);
                if w.floating {
                    all.push(Ledge { owner: w.id, rel: Rect { x: 0, y: 0, w: w.rect.w, h: 4 }, owner_size: size, floating: true });
                    continue;
                }
                let stale = seen.get(&w.id).is_none_or(|(sz, at, _)| *sz != size || at.elapsed() > Duration::from_secs(8));
                if stale && walked < 3 {
                    walked += 1;
                    let found = walk(&uia, &walker, &cache, w, scale);
                    seen.insert(w.id, (size, Instant::now(), found));
                }
                if let Some((sz, _, list)) = seen.get(&w.id) {
                    if *sz == size {
                        all.extend(list.iter().copied());
                    }
                }
            }
            seen.retain(|id, _| windows.iter().any(|w| w.id == *id));
            shared.lock().unwrap().ledges = all;
            std::thread::sleep(Duration::from_millis(1000));
        }
    });
}

fn cache_request(uia: &IUIAutomation) -> Option<IUIAutomationCacheRequest> {
    unsafe {
        let c = uia.CreateCacheRequest().ok()?;
        c.AddProperty(UIA_BoundingRectanglePropertyId).ok()?;
        c.AddProperty(UIA_ControlTypePropertyId).ok()?;
        c.AddProperty(UIA_IsOffscreenPropertyId).ok()?;
        Some(c)
    }
}

/// Is the top edge of this kind of control something to stand on (given its size)?
fn standable(t: UIA_CONTROLTYPE_ID, w: i32, h: i32, s: f64) -> bool {
    let (lw, lh) = (w as f64 / s, h as f64 / s);
    if lw < 48.0 || lh < 12.0 {
        return false;
    }
    match t {
        UIA_EditControlTypeId | UIA_ComboBoxControlTypeId | UIA_ToolBarControlTypeId | UIA_MenuBarControlTypeId
        | UIA_TabControlTypeId | UIA_ListControlTypeId | UIA_DataGridControlTypeId | UIA_TableControlTypeId
        | UIA_TreeControlTypeId | UIA_HeaderControlTypeId | UIA_StatusBarControlTypeId | UIA_DocumentControlTypeId
        | UIA_ProgressBarControlTypeId | UIA_SliderControlTypeId => true,
        // Panels, groups and wide buttons: only big enough to be a real surface.
        UIA_PaneControlTypeId | UIA_GroupControlTypeId | UIA_CustomControlTypeId => lw >= 160.0 && lh >= 40.0,
        UIA_ButtonControlTypeId | UIA_SplitButtonControlTypeId => lw >= 110.0,
        _ => false,
    }
}

/// Don't go inside these: web pages (Document) and the insides of lists and grids (rows of text, not surfaces).
fn leaf(t: UIA_CONTROLTYPE_ID) -> bool {
    matches!(t, UIA_DocumentControlTypeId | UIA_ListControlTypeId | UIA_DataGridControlTypeId | UIA_TableControlTypeId
        | UIA_TreeControlTypeId | UIA_EditControlTypeId | UIA_ComboBoxControlTypeId | UIA_ButtonControlTypeId | UIA_SplitButtonControlTypeId)
}

fn walk(uia: &IUIAutomation, walker: &IUIAutomationTreeWalker, cache: &IUIAutomationCacheRequest, w: &Win, scale: f64) -> Vec<Ledge> {
    let s = if scale > 0.0 { scale } else { 1.0 };
    let hwnd = HWND(w.id as *mut _);
    let Ok(root) = (unsafe { uia.ElementFromHandleBuildCache(hwnd, cache) }) else { return Vec::new() };
    let wr = w.rect;
    let mut tops: Vec<Rect> = Vec::new();
    let mut budget = 400; // controls per window, at most
    let started = Instant::now();
    let mut stack: Vec<(IUIAutomationElement, u32)> = vec![(root, 0)];
    while let Some((el, depth)) = stack.pop() {
        if budget == 0 || started.elapsed() > Duration::from_millis(250) {
            break;
        }
        let mut child = unsafe { walker.GetFirstChildElementBuildCache(&el, cache) }.ok();
        while let Some(c) = child {
            budget -= 1;
            if budget == 0 {
                break;
            }
            let t = unsafe { c.CachedControlType() }.unwrap_or_default();
            let off = unsafe { c.CachedIsOffscreen() }.map(|b| b.as_bool()).unwrap_or(true);
            if let (false, Ok(r)) = (off, unsafe { c.CachedBoundingRectangle() }) {
                let r = Rect::from(r);
                // Inside the window, not its own top edge (the window itself is already something to stand on).
                let x0 = r.x.max(wr.x);
                let x1 = r.right().min(wr.right());
                if r.y > wr.y + (14.0 * s) as i32 && r.y < wr.bottom() - (24.0 * s) as i32 && x1 - x0 > 0 && standable(t, x1 - x0, r.h, s) {
                    tops.push(Rect { x: x0, y: r.y, w: x1 - x0, h: 4 });
                }
                if depth < 6 && !leaf(t) && r.w > 0 && r.h > 0 {
                    stack.push((c.clone(), depth + 1));
                }
            }
            child = unsafe { walker.GetNextSiblingElementBuildCache(&c, cache) }.ok();
        }
    }
    // One edge reported twice (a control and its frame): keep the wider. The bottom of a stack of controls sits
    // right under another top: standing there he would stand inside it — keep the upper one, as on the Mac.
    tops.sort_by(|a, b| b.w.cmp(&a.w));
    let mut out: Vec<Rect> = Vec::new();
    for r in tops {
        let overlap = |o: &Rect| (o.right().min(r.right()) - o.x.max(r.x)).max(0);
        if out.iter().any(|o| (o.y - r.y).abs() <= (3.0 * s) as i32 && overlap(o) > 0) {
            continue;
        }
        out.push(r);
    }
    let room = (30.0 * s) as i32;
    let keep: Vec<Rect> = out
        .iter()
        .filter(|r| !out.iter().any(|o| o.y < r.y - (3.0 * s) as i32 && r.y - o.y <= room && (o.right().min(r.right()) - o.x.max(r.x)) as f64 >= r.w as f64 * 0.6))
        .copied()
        .collect();
    keep.into_iter()
        .take(40)
        .map(|r| Ledge { owner: w.id, rel: Rect { x: r.x - wr.x, y: r.y - wr.y, w: r.w, h: 4 }, owner_size: (wr.w, wr.h), floating: false })
        .collect()
}
