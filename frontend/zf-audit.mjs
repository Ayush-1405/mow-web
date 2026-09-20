// TEMPORARY responsive/perf audit (deleted after use). Drives headless Edge over the DevTools protocol against `vite preview`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE || "http://localhost:5199";
const OUT = process.env.OUT || "zf-audit-out";
const ONLY_VP = (process.env.VP || "").split(",").filter(Boolean);
const ONLY_ROUTES = (process.env.ROUTES || "").split(",").filter(Boolean);
const SHOTS = (process.env.SHOTS || "").split(",").filter(Boolean); // viewport names to screenshot
fs.mkdirSync(OUT, { recursive: true });

const env = Object.fromEntries(fs.readFileSync(".env", "utf8").split(/\r?\n/).filter((l) => /^VITE_/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim()]));
const REF = env.VITE_SUPABASE_PROJECT_REF || "bykmyttaesuyjwvtnxks";
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email: "zf3-audit@example.test", password: "Zf3#Audit-7742" });
if (authErr) throw authErr;
const { data: projRows } = await sb.from("projects").select("id").eq("archived", false).limit(1);
const PID = projRows?.[0]?.id;
const { data: jobRows } = await sb.from("inhouse_production_requests").select("id").limit(1);
const JID = jobRows?.[0]?.id;

const VIEWPORTS = [
  { name: "phone-320", w: 320, h: 640, dsf: 2, mobile: true },
  { name: "phone-360", w: 360, h: 740, dsf: 3, mobile: true },
  { name: "phone-390", w: 390, h: 844, dsf: 3, mobile: true },
  { name: "phone-430", w: 430, h: 932, dsf: 3, mobile: true },
  { name: "tablet-768", w: 768, h: 1024, dsf: 2, mobile: true },
  { name: "tablet-1024", w: 1024, h: 768, dsf: 2, mobile: true },
  { name: "laptop-1366", w: 1366, h: 768, dsf: 1, mobile: false },
  { name: "desktop-1920", w: 1920, h: 1080, dsf: 1, mobile: false },
].filter((v) => !ONLY_VP.length || ONLY_VP.includes(v.name));

const ROUTES = [
  "/", "view:1", "view:2", "view:3", "view:4", "view:5", "view:6", "/tasks", "/bridges", "/chat", "/notifications", "/management", "/reports", "/analytics",
  "/interior-projects", "/interior-projects/new", "/interior-projects/timeline", "/interior-projects/daily-updates", "/interior-projects/tasks", "/interior-projects/materials",
  "/interior-projects/purchase-management", "/interior-projects/working-drawings", "/interior-projects/site-execution", "/interior-projects/payments", "/interior-projects/communication",
  `/interior-projects/detail/${PID}`, `/interior-projects/detail/${PID}?tab=dailyUpdates`, `/interior-projects/detail/${PID}?tab=files`, `/interior-projects/master-report/${PID}`,
  "/factory", "/factory/tasks", "/factory/job-cards", "/factory/overview", "/factory/inbox", "/factory/job-orders", `/factory-job/${JID}`, "/factory-request",
  "/retail", "/retail/leads", "/retail/orders", "/marketing", "/procurement", "/inventory", "/dispatch", "/ai-tasks", "/users",
].filter((r) => !ONLY_ROUTES.length || ONLY_ROUTES.some((x) => r.includes(x)));

const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-edge-"));
const PORT = 9333 + Math.floor(Math.random() * 300);
const proc = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, "--disable-gpu", "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i += 1) {
  try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = list.find((t) => t.type === "page"); } catch { /* not up yet */ }
  if (!target) await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map(); const handlers = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); } else if (d.method) handlers.forEach((h) => h(d));
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || "")); return r.result.value; };

let consoleErrors = []; let badResponses = [];
handlers.push((d) => {
  if (d.method === "Runtime.exceptionThrown") consoleErrors.push("EXC " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text).split("\n")[0]);
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") consoleErrors.push("ERR " + d.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  if (d.method === "Network.responseReceived" && d.params.response.status >= 400) badResponses.push(d.params.response.status + " " + d.params.response.url.replace(/\?.*/, "").slice(-90));
});
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");

const initScript = `
  try { localStorage.setItem('sb-${REF}-auth-token', ${JSON.stringify(JSON.stringify(auth.session))}); } catch (e) {}
  window.__cls = 0; window.__lt = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
`;
await send("Page.addScriptToEvaluateOnNewDocument", { source: initScript });

const AUDIT = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const touch = matchMedia('(pointer:coarse)').matches;
  const sel = (el) => { const parts = []; let e = el; for (let i = 0; i < 4 && e && e.nodeType === 1; i += 1) { let s = e.tagName.toLowerCase(); if (e.id) s += '#' + e.id; else if (typeof e.className === 'string' && e.className.trim()) s += '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.'); parts.unshift(s); e = e.parentElement; } return parts.join('>'); };
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
  const scrollAnc = (el) => { let p = el.parentElement; while (p && p !== document.body) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowX)) return true; if (/(hidden|clip)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true; p = p.parentElement; } return false; };
  const root = document.getElementById('root');
  const all = [...root.querySelectorAll('*')].filter(vis);
  const off = [];
  for (const el of all) {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (cs.position === 'fixed' && (r.right <= 0 || r.left >= vw)) continue;
    const over = Math.max(r.right - vw, -r.left);
    if (over > 1 && !scrollAnc(el)) off.push({ sel: sel(el), over: Math.round(over), w: Math.round(r.width) });
  }
  const seen = new Set(); const offenders = off.sort((a, b) => b.over - a.over).filter((o) => { const k = o.sel.split('>').slice(-2).join('>'); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
  const clipped = [];
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (/(hidden|clip)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== 'ellipsis' && !el.matches('html,body,#root') && el.clientWidth > 0) clipped.push({ sel: sel(el), sw: el.scrollWidth, cw: el.clientWidth });
  }
  const small = []; const inputZoom = [];
  if (touch) {
    for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem], summary')) {
      if (!vis(el) || el.closest('.sr-only')) continue;
      const r = el.getBoundingClientRect(); if (/(checkbox|radio)/.test(el.type) && el.closest('label')) continue;
      if (Math.min(r.width, r.height) < 43.5 && !(el.tagName === 'A' && el.closest('p, li, .sub, .n-title') && !el.classList.contains('btn'))) small.push({ sel: sel(el), w: Math.round(r.width), h: Math.round(r.height), t: (el.innerText || el.getAttribute('aria-label') || el.placeholder || '').trim().slice(0, 24) });
    }
    for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea')) {
      if (vis(el) && parseFloat(getComputedStyle(el).fontSize) < 16) inputZoom.push(sel(el));
    }
  }
  const docW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  const nav = document.querySelector('.bottom-nav'); const navR = nav && vis(nav) ? nav.getBoundingClientRect() : null;
  return { vw, vh, touch, docOverflow: docW > vw + 1 ? docW - vw : 0, offenders, clipped: clipped.slice(0, 4), smallCount: small.length, small: small.slice(0, 5), inputZoomCount: inputZoom.length, inputZoom: [...new Set(inputZoom)].slice(0, 3),
    navBottomGap: navR ? Math.round(vh - navR.bottom) : null, cls: Math.round((window.__cls || 0) * 1000) / 1000, longTasks: (window.__lt || []).length, longTaskMax: Math.max(0, ...(window.__lt || [])) };
})()`;

const SETTLE = `new Promise((res) => { const t0 = Date.now(); (function poll() { const busy = document.querySelector('.skeleton-block, .spinner') || /Loading/.test((document.getElementById('root') || {}).innerText || '') && Date.now() - t0 < 5000; if (!busy || Date.now() - t0 > 6000) setTimeout(res, 600); else setTimeout(poll, 150); })(); })`;

const results = [];
for (const vp of VIEWPORTS) {
  await send("Emulation.setDeviceMetricsOverride", { width: vp.w, height: vp.h, deviceScaleFactor: vp.dsf, mobile: vp.mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: vp.mobile, maxTouchPoints: vp.mobile ? 5 : 0 });
  await send("Page.navigate", { url: BASE + "/" });
  await sleep(2500); await evalJs(SETTLE);
  for (const route of ROUTES) {
    consoleErrors = []; badResponses = [];
    try {
      if (route.startsWith("view:")) {
        await evalJs(`history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate')); 0`);
        await sleep(400);
        const n = Number(route.slice(5));
        const ok = await evalJs(`(() => { const b = [...document.querySelectorAll('.bottom-nav button')]; if (!b[${n}]) return false; b[${n}].click(); return true; })()`);
        if (!ok) continue;
      } else {
        await evalJs(`history.pushState({}, '', ${JSON.stringify(route)}); dispatchEvent(new PopStateEvent('popstate')); 0`);
      }
      await sleep(500); await evalJs(SETTLE);
      const a = await evalJs(AUDIT);
      const row = { vp: vp.name, route, ...a, errors: [...new Set(consoleErrors)].slice(0, 3), bad: [...new Set(badResponses)].slice(0, 3) };
      results.push(row);
      if (SHOTS.includes(vp.name)) {
        const shot = await send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(path.join(OUT, `${vp.name}__${route.replace(/[^a-z0-9]+/gi, "_")}.png`), Buffer.from(shot.data, "base64"));
      }
    } catch (e) { results.push({ vp: vp.name, route, fatal: String(e.message).slice(0, 160) }); }
  }
  process.stdout.write(`done ${vp.name}\n`);
}
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
ws.close(); proc.kill();
try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* temp */ }
await sb.auth.signOut();
console.log("results:", results.length);
process.exit(0);
