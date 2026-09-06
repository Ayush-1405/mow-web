import { createClient } from "@supabase/supabase-js";

// Mood of Wood — Staff Pilot — shared Supabase client.
//
// Project: bykmyttaesuyjwvtnxks ("mood- of- wood- interior"). The URL and
// publishable (anon) key are not secrets — they are meant to ship in the
// browser bundle; every real permission boundary is enforced server-side via
// RLS/RPCs and the staff-* Edge Functions, never by hiding these values.
// Override via VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (a .env file) for
// a different environment (e.g. a separate staging project) without editing
// this file.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://bykmyttaesuyjwvtnxks.supabase.co";
const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5a215dHRhZXN1eWp3dnRueGtzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2OTI4NjAsImV4cCI6MjEwMjI2ODg2MH0.J4kRDYwoVsvIs-KdBHggUmFjEYIKikVJcgSSr8ia7Yo";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Login here goes through the staff-login Edge Function + setSession(),
    // never Supabase's own email/password/OAuth redirect flow.
    detectSessionInUrl: false,
  },
});

export const SUPABASE_URL_BASE = SUPABASE_URL;
export const SUPABASE_ANON_KEY_VALUE = SUPABASE_ANON_KEY;
