// Mood of Wood — Node API — health check.
//
// GET /api/health — confirms Vercel is building and routing api/* correctly
// alongside the existing frontend build (see ../vercel.json), and confirms
// the required Supabase environment variables are present, without
// touching the database. Add authenticated/DB-touching checks here only
// if a later phase genuinely needs them — this endpoint should stay cheap
// and side-effect-free since it's meant for quick deploy verification.

import { applyCors } from "./_lib/cors.js";

export default function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method !== "GET") {
    res.status(405).json({ error: { en: "This action is not supported.", gu: "આ ક્રિયા સમર્થિત નથી." } });
    return;
  }

  const requiredEnv = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
  const missingEnv = requiredEnv.filter((name) => !process.env[name]);

  res.status(missingEnv.length === 0 ? 200 : 500).json({
    ok: missingEnv.length === 0,
    missingEnv,
    timestamp: new Date().toISOString(),
  });
}
