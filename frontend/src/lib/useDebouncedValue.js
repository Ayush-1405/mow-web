import { useEffect, useState } from "react";

// Returns `value`, but updated only after it has stopped changing for
// `delayMs` — used for search/filter inputs so a fast typist doesn't
// re-run an expensive filter/query on every single keystroke. The input
// itself always stays fully responsive (it's bound to the caller's own
// immediate state, never to this debounced value) — only the DERIVED
// work (filtering a list, querying Supabase) waits for the pause.
export function useDebouncedValue(value, delayMs = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
