// Mood of Wood — MVP Pilot Edge Functions — shared CORS helper.
//
// Origin allow-list, in order of precedence:
//   1. ALLOWED_ORIGINS env var (comma-separated exact origins) — set this via
//      `supabase secrets set ALLOWED_ORIGINS=https://staff.moodofwood.app,...`
//      once the project has that secret configured. Not set as of
//      2026-09-06, which is why (2) and (3) below exist.
//   2. DEFAULT_PROD_ORIGINS — exact known-good production origins, hardcoded
//      here as a working fallback until ALLOWED_ORIGINS is set. Includes the
//      intended custom domain and the current Vercel production URL.
//   3. VERCEL_PREVIEW_ORIGIN_RE — a pattern scoped to THIS project's Vercel
//      deployments only (hostnames starting with "mood-of-wood-staff-pilot-"
//      on *.vercel.app), so preview/branch deployments work without ever
//      matching an arbitrary, attacker-controlled origin. This is not a
//      blanket "*.vercel.app" wildcard.
//   4. DEFAULT_DEV_ORIGINS — localhost, for local `npm run dev`.
//
// An origin matching none of these gets NO Access-Control-Allow-Origin
// header at all (never a wildcard, never an echo of an arbitrary origin),
// so the browser blocks the response from being read by any untrusted page.
// Access-Control-Allow-Credentials is never set by this file — these
// functions are called with an `apikey`/`Authorization` header, not
// cookies, so credentialed CORS is never needed and never combined with a
// wildcard origin.

const rawOrigins = Deno.env.get("ALLOWED_ORIGINS") ?? "";

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

const ALLOWED_ORIGINS = Array.from(
  new Set([
    ...rawOrigins
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    ...DEFAULT_PROD_ORIGINS,
    ...DEFAULT_DEV_ORIGINS,
  ]),
);

// Matches only this project's Vercel deployments, e.g.
// https://mood-of-wood-staff-pilot-<hash>-mow3.vercel.app or any other
// preview alias Vercel generates from this exact project name — never a
// different project or an attacker-chosen "*.vercel.app" host.
const VERCEL_PREVIEW_ORIGIN_RE = /^https:\/\/mood-of-wood-staff-pilot-[a-z0-9-]+\.vercel\.app$/;

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.includes(origin) || VERCEL_PREVIEW_ORIGIN_RE.test(origin);
}

export function buildCorsHeaders(requestOrigin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (requestOrigin && isAllowedOrigin(requestOrigin)) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
  }
  return headers;
}

/** Call at the top of every handler, before parsing the body or checking auth. Returns a 204 response for OPTIONS, or null to continue. */
export function handlePreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: buildCorsHeaders(req.headers.get("origin")) });
  }
  return null;
}
