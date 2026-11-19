import { useEffect, useRef } from "react";
import { createChelik, type Chelik, type ChelikOptions } from "./index";

type Props = ChelikOptions & { onReady?: (c: Chelik) => void; paused?: boolean };

/** Options that can follow prop changes through set(). (root, scroller, storageKey, autoStart, greet are read once.) */
const LIVE = ["size", "lang", "colors", "traits", "ink", "fps", "lowPower", "targets", "page", "avoid", "themeToggle", "trackPointer", "respectReducedMotion"] as const;
/** Compare by value, so inline objects (`colors={{…}}`) do not count as a change on every render. */
const same = (a: unknown, b: unknown) => a === b || (typeof a === "object" && typeof b === "object" && a !== null && b !== null && !(a instanceof Element) && !(b instanceof Element) && JSON.stringify(a) === JSON.stringify(b));

/**
 * React wrapper: `<Akko size={48} />`. Renders nothing itself; he lives in document.body.
 * Pass `onReady` to get the instance (pause, play, …). Changed props (size, lang, colors, traits…) are passed on
 * with set(); the callbacks always call the latest ones.
 */
export function Akko(props: Props) {
  const ref = useRef<Chelik | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const applied = useRef<Props>(props);

  useEffect(() => {
    const { onReady, paused, onAct, onInteractive, onPerch, onMood, ...opts } = latest.current;
    const c = createChelik({
      ...opts,
      autoStart: !paused,
      onAct: (n) => latest.current.onAct?.(n),
      onInteractive: (on) => latest.current.onInteractive?.(on),
      onPerch: (on) => latest.current.onPerch?.(on),
      onMood: (m) => latest.current.onMood?.(m),
    });
    ref.current = c;
    applied.current = latest.current;
    onReady?.(c);
    return () => { c.destroy(); if (ref.current === c) ref.current = null; };
  }, []);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const prev = applied.current;
    const patch: Partial<ChelikOptions> = {};
    let changed = false;
    for (const k of LIVE) {
      if (!same(prev[k], props[k])) { (patch as Record<string, unknown>)[k] = props[k]; changed = true; }
    }
    applied.current = props;
    if (changed) c.set(patch);
  });

  useEffect(() => { if (props.paused) ref.current?.pause(); else ref.current?.resume(); }, [props.paused]);
  return null;
}

/** Old name, kept so existing code keeps working. */
export const MiniChelik = Akko;

export default Akko;
