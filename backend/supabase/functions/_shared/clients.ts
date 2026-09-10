// Mood of Wood — MVP Pilot Edge Functions — Supabase client factories.
//
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected
// automatically into every Supabase Edge Function's environment — they are
// NOT set manually via `supabase secrets set`. This file is the ONLY place
// SUPABASE_SERVICE_ROLE_KEY is read. It is used solely to construct a
// server-side client (adminClient) and is never logged, never echoed into a
// response body, and never forwarded to the caller in any header.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

/** Full-privilege server-side client. Bypasses RLS. Never exposed to the client. */
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Anonymous client — used only to run auth.getUser()/signInWithPassword() against Supabase Auth. */
export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Client scoped to the caller's own verified session — table reads through this respect RLS as that user. */
export function userScopedClient(bearerToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
}

export function extractBearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? req.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Verifies a bearer token against Supabase Auth and returns the verified user,
 * or null if the token is missing/invalid/expired. Callers must NEVER use a
 * user id taken from a request body — only the id returned here.
 */
export async function verifyCaller(token: string) {
  const client = anonClient();
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}
