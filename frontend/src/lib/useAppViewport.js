import { useEffect } from "react";

// Keeps the app shell exactly as tall as the VISIBLE viewport (`--app-height`), so on a touch device the chat composer stays above the
// on-screen keyboard and the browser chrome. Everything else uses the CSS fallback (100dvh).
//   * mounted ONCE (empty deps), listeners are passive, throttled through one requestAnimationFrame, removed on cleanup
//   * it only writes a CSS variable -- no React state, so it can never cause a re-render or a refresh loop
//   * touch devices only (feature detection via the pointer media query, never the user agent)
export function useAppViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !window.matchMedia || !window.matchMedia("(pointer: coarse)").matches) return undefined;
    const root = document.documentElement;
    let raf = 0;
    const apply = () => {
      raf = 0;
      root.style.setProperty("--app-height", `${Math.round(vv.height)}px`);
      // iOS scrolls the (non-scrollable) page to reveal a focused field; the shell already fits the visible area, so undo that shift
      const se = document.scrollingElement;
      if (se && se.scrollTop !== 0) se.scrollTop = 0;
    };
    const schedule = () => { if (!raf) raf = window.requestAnimationFrame(apply); };
    apply();
    vv.addEventListener("resize", schedule, { passive: true });
    vv.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("orientationchange", schedule, { passive: true });
    return () => {
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      window.removeEventListener("orientationchange", schedule);
      if (raf) window.cancelAnimationFrame(raf);
      root.style.removeProperty("--app-height");
    };
  }, []);
}
