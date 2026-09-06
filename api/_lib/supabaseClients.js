// Mood of Wood — Node API — Supabase client factories.
//
// Ported from supabase/functions/_shared/clients.ts. Environment variables
// read here (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY)
// must be set in the Vercel project's Environment Variables settings —
// they are server-side only and must NEVER be prefixed VITE_ (that prefix
// is reserved for values Vite inlines into the browser bundle). This file
// is the only place SUPABASE_SERVICE_ROLE_KEY is read. It is used solely
// to construct a server-side client (adminClient) and is never logged,
// never echoed into a response body, and never forwarded to the caller in
// any header.

import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Full-privilege server-side client. Bypasses RLS. Never exposed to the client. */
export function adminClient() {
  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Anonymous client — used only to run auth.getUser()/signInWithPassword() against Supabase Auth. */
export function anonClient() {
  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_ANON_KEY");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Client scoped to the caller's own verified session — table reads through this respect RLS as that user. */
export function userScopedClient(bearerToken) {
  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_ANON_KEY");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
}

export function extractBearerToken(req) {
  const header = req.headers.authorization ?? req.headers.Authorization;
  if (!header || typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Verifies a bearer token against Supabase Auth and returns the verified
 * user, or null if the token is missing/invalid/expired. Callers must
 * NEVER use a user id taken from a request body — only the id returned
 * here.
 */
export async function verifyCaller(token) {
  const client = anonClient();
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}
