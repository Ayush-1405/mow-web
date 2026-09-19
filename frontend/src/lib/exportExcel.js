// Shared Excel export -- same xlsx dependency/pattern already used by
// InteriorMasterReport.jsx (dynamic import, json_to_sheet, writeFile). Kept
// in one place so every Factory board exports consistently instead of
// each page reinventing it. Exports exactly the rows the caller passed in
// (the already-filtered, already-RLS-scoped array a board is showing), so
// the exported totals can never diverge from what's on screen and never
// include anything the current user isn't authorized to see.
export async function exportRowsToExcel(filename, sheetName, rows) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows && rows.length ? rows : [{}]);
  XLSX.utils.book_append_sheet(wb, ws, (sheetName || "Sheet1").slice(0, 31));
  XLSX.writeFile(wb, filename);
}
