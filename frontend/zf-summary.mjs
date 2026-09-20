import fs from "node:fs";
const dir = process.argv[2] || "zf-audit-out";
const r = JSON.parse(fs.readFileSync(dir + "/results.json", "utf8"));
const fatal = r.filter((x) => x.fatal);
console.log(`rows ${r.length}, fatal ${fatal.length}`);
fatal.slice(0, 8).forEach((x) => console.log("  FATAL", x.vp, x.route, x.fatal));
const over = r.filter((x) => x.docOverflow > 0);
console.log(`\nDOCUMENT horizontal overflow: ${over.length}`);
over.slice(0, 12).forEach((x) => console.log(`  ${x.vp} ${x.route} +${x.docOverflow}px  ${x.offenders.slice(0, 2).map((o) => `${o.sel} (+${o.over})`).join(" | ")}`));
const agg = {};
for (const x of r) for (const o of x.offenders || []) { const k = o.sel.split(">").slice(-2).join(">"); (agg[k] ||= { n: 0, max: 0, vps: new Set(), routes: new Set() }); agg[k].n += 1; agg[k].max = Math.max(agg[k].max, o.over); agg[k].vps.add(x.vp); agg[k].routes.add(x.route); }
console.log("\nELEMENTS extending past the viewport (not inside a scroller):");
Object.entries(agg).sort((a, b) => b[1].n - a[1].n).slice(0, 15).forEach(([k, v]) => console.log(`  ${k}  x${v.n} max+${v.max}px  vps:${[...v.vps].join(",")}  e.g. ${[...v.routes][0]}`));
const cl = {};
for (const x of r) for (const o of x.clipped || []) { const k = o.sel.split(">").slice(-2).join(">"); (cl[k] ||= { n: 0, e: x.route + "@" + x.vp + ` ${o.sw}>${o.cw}` }).n += 1; }
console.log("\nCLIPPED content (overflow hidden with hidden text/content):");
Object.entries(cl).sort((a, b) => b[1].n - a[1].n).slice(0, 10).forEach(([k, v]) => console.log(`  ${k} x${v.n} e.g. ${v.e}`));
const sm = {};
for (const x of r) for (const o of x.small || []) { const k = o.sel.split(">").slice(-1)[0]; (sm[k] ||= { n: 0, e: `${o.w}x${o.h} "${o.t}" ${x.route}@${x.vp}` }).n += 1; }
console.log("\nTOUCH targets under 44px (touch viewports):");
Object.entries(sm).sort((a, b) => b[1].n - a[1].n).slice(0, 14).forEach(([k, v]) => console.log(`  ${k} x${v.n} e.g. ${v.e}`));
const iz = {};
for (const x of r) for (const s of x.inputZoom || []) { const k = s.split(">").slice(-1)[0]; (iz[k] ||= { n: 0, e: x.route + "@" + x.vp }).n += 1; }
console.log("\nINPUTS under 16px (iOS zooms the page on focus):");
Object.entries(iz).sort((a, b) => b[1].n - a[1].n).slice(0, 8).forEach(([k, v]) => console.log(`  ${k} x${v.n} e.g. ${v.e}`));
const cls = r.filter((x) => x.cls > 0.05).sort((a, b) => b.cls - a.cls);
console.log(`\nLAYOUT SHIFT (CLS > 0.05): ${cls.length}`);
cls.slice(0, 6).forEach((x) => console.log(`  ${x.vp} ${x.route} cls=${x.cls}`));
const lt = r.filter((x) => x.longTaskMax > 200).sort((a, b) => b.longTaskMax - a.longTaskMax);
console.log(`\nLONG TASKS > 200ms: ${lt.length}`);
lt.slice(0, 6).forEach((x) => console.log(`  ${x.vp} ${x.route} max ${x.longTaskMax}ms (${x.longTasks} tasks)`));
const er = {};
for (const x of r) for (const e of [...(x.errors || []), ...(x.bad || []).map((b) => "HTTP " + b)]) { (er[e] ||= { n: 0, e: x.route }).n += 1; }
console.log("\nCONSOLE errors / failed requests:");
Object.entries(er).sort((a, b) => b[1].n - a[1].n).slice(0, 12).forEach(([k, v]) => console.log(`  x${v.n} ${k}  e.g. ${v.e}`));
const nav = r.filter((x) => x.navBottomGap != null && x.navBottomGap !== 0);
console.log(`\nBOTTOM NAV not flush with viewport bottom: ${nav.length}` + (nav[0] ? `  e.g. ${nav[0].vp} ${nav[0].route} gap ${nav[0].navBottomGap}` : ""));
console.log("touch emulation matched on:", [...new Set(r.filter((x) => x.touch).map((x) => x.vp))].join(","));
