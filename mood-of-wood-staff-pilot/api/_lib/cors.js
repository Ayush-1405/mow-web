// Mood of Wood — Node API — shared CORS helper.
//
// Mirrors supabase/functions/_shared/cors.ts (fixed this session after a
// live production CORS failure). Most calls to these endpoints will be
// same-origin (frontend and /api/* served from the same Vercel deployment),
// where CORS doesn't even apply — this exists mainly for local dev
// (frontend on localhost:5173 calling a deployed preview) and any future
// cross-origin use, so the app doesn't repeat the earlier ALLOWED_ORIGINS
// mistake.
//
// Same allow-list logic as the Deno version: an env var override, plus
// hardcoded known-good production origins, plus a strict regex scoped to
// only this project's Vercel deployments (never a blanket "*.vercel.app"
// wildcard, never a reflected arbitrary origin).

const DEFAULT_PROD_ORIGINS = [
  "https://staff.moodofwood.app",
  "https://mood-of-wood-staff-pilot-ee3f.vercel.app",
  "https://mood-of-wood-staff-pilot-mow3.vercel.app",
  "https://mood-of-wood-staff-pilot-git-main-mow3.vercel.app",
];

const DEFAULT_DEV_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:5175",
];

const VERCEL_PREVIEW_ORIGIN_RE = /^https:\/\/mood-of-wood-staff-pilot-[a-z0-9-]+\.vercel\.app$/;

function allowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS ?? "";
  return Array.from(
    new Set([
      ...raw
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
      ...DEFAULT_PROD_ORIGINS,
      ...DEFAULT_DEV_ORIGINS,
    ]),
  );
}

function isAllowedOrigin(origin) {
  return allowedOrigins().includes(origin) || VERCEL_PREVIEW_ORIGIN_RE.test(origin);
}

/** Sets CORS headers on the response for the request's Origin, and handles OPTIONS preflight. Returns true if the request was an OPTIONS preflight (caller should stop after this). */
export function applyCors(req, res) {
  const origin = req.headers.origin ?? null;
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}
