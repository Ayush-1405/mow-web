-- mvp_pilot_storage_allow_voice_mime_v2_1q
--
-- Fixes voice-message recording failing at upload time in production.
--
-- mvp_pilot_voice_attachments_and_daily_reminders_v2_1m added file_type =
-- 'voice' support to staff_record_attachment() and to the staff-file-url
-- Edge Function's MIME_WHITELIST, but never updated the storage.buckets
-- row itself. Supabase Storage enforces allowed_mime_types independently,
-- BEFORE staff_record_attachment ever runs (the RPC only records metadata
-- for a file that already landed in Storage) — so every voice-note PUT to
-- a validly-minted signed upload URL was rejected by Storage itself with
-- a mime-type error, even though the Edge Function and RPC both already
-- accepted it. Confirmed live: the bucket's allowed_mime_types array had
-- no audio/* entries at all as of 2026-09-06.
--
-- This adds exactly the 7 audio types already whitelisted everywhere else
-- (staff_record_attachment's mime_type check, and validation.ts's
-- MIME_WHITELIST.voice / ALL_APPROVED_MIME_TYPES in every staff-*
-- function) — no new type introduced, just closing the one place that
-- was missed.
UPDATE storage.buckets
SET allowed_mime_types = allowed_mime_types || ARRAY[
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-m4a',
  'audio/aac'
]::text[]
WHERE id = 'staff-attachments'
  AND NOT (allowed_mime_types @> ARRAY['audio/webm']::text[]);
