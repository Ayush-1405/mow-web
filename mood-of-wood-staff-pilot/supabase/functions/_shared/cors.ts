// Mood of Wood — MVP Pilot Edge Functions — shared CORS helper.
// Origin allow-list is read from the ALLOWED_ORIGINS environment variable
// (comma-separated), PLUS a small fixed set of local dev origins below —
// this fallback exists because ALLOWED_ORIGINS was never actually set via
// `supabase secrets set` for this project, which otherwise blocks every
// browser call to these functions (staff-login included) regardless of
// deployment. Set ALLOWED_ORIGINS to your real deployed origin(s) for
// production; these dev origins stay in place either way since they only
// ever match localhost. An origin not on either list gets no
// Access-Control-Allow-Origin header at all (not a wildcard, not an echo of
// an arbitrary origin) so the browser blocks the response from being read
// by any page that isn't explicitly trusted.

const rawOrigins = Deno.env.get("ALLOWED_ORIGINS") ?? "";
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
    ...DEFAULT_DEV_ORIGINS,
  ]),
);

export function buildCorsHeaders(requestOrigin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
  }
  return headers;
}

/** Call at the top of every handler. Returns a 204 response for OPTIONS, or null to continue. */
export function handlePreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: buildCorsHeaders(req.headers.get("origin")) });
  }
  return null;
}
