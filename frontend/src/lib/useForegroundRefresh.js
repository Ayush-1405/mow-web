import { useEffect } from "react";

// Belt-and-suspenders on top of Realtime: if a websocket was dropped while
// the tab was backgrounded/offline, this silently re-runs `cb` (a screen's
// own existing load()/loadX() function -- never a page reload) once the
// device/tab is actually usable again. Never signs the user out or forces
// a re-login -- it only re-fetches data, same as any other background
// refresh in this app.
export function useForegroundRefresh(cb) {
  useEffect(() => {
    if (typeof cb !== "function") return undefined;
    function onVisible() {
      if (!document.hidden) cb();
    }
    window.addEventListener("online", cb);
    window.addEventListener("focus", cb);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", cb);
      window.removeEventListener("focus", cb);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [cb]);
}
