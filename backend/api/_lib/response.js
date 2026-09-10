// Mood of Wood — Node API — shared response helpers.
// Mirrors supabase/functions/_shared/response.ts. Every endpoint should
// call applyCors(req, res) first (api/_lib/cors.js), then use these so
// every response — success, validation, auth, or unexpected error — has
// the same JSON envelope shape the frontend already expects from the
// Edge Functions/RPCs these endpoints are replacing.

export function sendError(res, status, message) {
  res.status(status).json({ error: { en: message.en, gu: message.gu } });
}

export function sendOk(res, data, status = 200) {
  res.status(status).json(data);
}
