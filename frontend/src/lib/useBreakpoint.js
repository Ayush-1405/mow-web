import { useEffect, useState } from "react";

// "mobile" < 768px <= "tablet" < 1024px <= "desktop". Driven by matchMedia
// (not resize polling) so it only re-renders when a breakpoint is actually
// crossed -- rotating a phone, resizing a window, or browser text-zoom
// (which changes the CSS-px viewport width) all flow through it.
const TABLET = "(min-width: 768px)";
const DESKTOP = "(min-width: 1024px)";

function read() {
  if (typeof window === "undefined" || !window.matchMedia) return "desktop";
  if (window.matchMedia(DESKTOP).matches) return "desktop";
  if (window.matchMedia(TABLET).matches) return "tablet";
  return "mobile";
}

export function useBreakpoint() {
  const [bp, setBp] = useState(read);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const lists = [window.matchMedia(TABLET), window.matchMedia(DESKTOP)];
    const onChange = () => setBp(read());
    lists.forEach((m) => m.addEventListener("change", onChange));
    onChange();
    return () => lists.forEach((m) => m.removeEventListener("change", onChange));
  }, []);
  return bp;
}
