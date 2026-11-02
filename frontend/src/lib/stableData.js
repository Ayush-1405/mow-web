// Keeps object identity across refetches when the server returned the same data. Screens refetch on every realtime event and whenever the
// app returns to the foreground; without this each refetch hands React brand new objects, so every memo below it misses and the whole list
// re-renders even though nothing on screen changed.

function same(a, b) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

// Returns `prev` itself when nothing changed.
export function reuseValue(prev, next) {
  return same(prev, next) ? prev : next;
}

// Rows keep their previous object when unchanged; returns `prev` itself when no row changed and the order is the same.
export function reuseRows(prev, next, idKey = "id") {
  const prevById = new Map(prev.map((row) => [row[idKey], row]));
  const merged = next.map((row) => {
    const old = prevById.get(row[idKey]);
    return old !== undefined && same(old, row) ? old : row;
  });
  return merged.length === prev.length && merged.every((row, i) => row === prev[i]) ? prev : merged;
}

// Same as reuseRows, for a { key: value } map.
export function reuseMap(prev, next) {
  const keys = Object.keys(next);
  const merged = {};
  keys.forEach((k) => { merged[k] = k in prev && same(prev[k], next[k]) ? prev[k] : next[k]; });
  return keys.length === Object.keys(prev).length && keys.every((k) => k in prev && merged[k] === prev[k]) ? prev : merged;
}
