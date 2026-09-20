-- v2_87a -- Reply -> Chat consolidation, PHASE A: schema. Additive only; nothing is dropped, nothing legacy is modified.
--
-- The legacy "Reply" system is public.task_messages (+ task_message_reads). This adds what Chat needs to hold the imported history
-- (legacy identifiers, original context, a bucket per attachment), the new `project` conversation type, and the audit / review tables.

-- ---- Project chat: type + relationship ------------------------------------------------------------------------------------
alter table public.chat_conversations drop constraint if exists chat_conversations_type_check;
alter table public.chat_conversations add constraint chat_conversations_type_check
  check (type = any (array['direct','department','team','task','job_card','bridge','management','project','ai_assistant']));

-- project_id: set on `project` conversations (canonical, unique) and carried on task / bridge conversations as context only.
alter table public.chat_conversations add column if not exists project_id uuid references public.projects(id) on delete set null;
create unique index if not exists chat_uq_project on public.chat_conversations (project_id) where type = 'project';
create index if not exists chat_conv_project_idx on public.chat_conversations (project_id) where project_id is not null;

-- ---- Legacy identifiers + original context on messages --------------------------------------------------------------------
alter table public.chat_messages add column if not exists legacy_source_type text;
alter table public.chat_messages add column if not exists legacy_source_id uuid;
alter table public.chat_messages add column if not exists imported_at timestamptz;
alter table public.chat_messages add column if not exists context jsonb not null default '{}'::jsonb;
-- one legacy reply can only ever become ONE chat message (this is what makes the migration re-runnable)
create unique index if not exists chat_msg_uq_legacy on public.chat_messages (legacy_source_type, legacy_source_id) where legacy_source_id is not null;

-- ---- Attachments: reference the ORIGINAL private object instead of re-uploading it -----------------------------------------
alter table public.chat_message_attachments add column if not exists bucket text not null default 'chat-attachments';
alter table public.chat_message_attachments add column if not exists legacy_source_type text;
alter table public.chat_message_attachments add column if not exists legacy_source_id uuid;
alter table public.chat_message_attachments drop constraint if exists chat_message_attachments_bucket_check;
alter table public.chat_message_attachments add constraint chat_message_attachments_bucket_check check (bucket in ('chat-attachments', 'staff-attachments'));
create unique index if not exists chat_att_uq_legacy on public.chat_message_attachments (legacy_source_type, legacy_source_id) where legacy_source_id is not null;

-- ---- Audit + review (never readable by ordinary users) ---------------------------------------------------------------------
create table if not exists public.chat_legacy_audit (
  id uuid primary key default gen_random_uuid(),
  event text not null,                -- reply_migrated | attachment_linked | migration_failed | reply_write_disabled | ui_switched | ...
  legacy_type text,
  legacy_id uuid,
  conversation_id uuid,
  message_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists chat_legacy_audit_event_idx on public.chat_legacy_audit (event, created_at desc);

create table if not exists public.chat_legacy_review (
  legacy_reply_id uuid primary key,           -- one review row per legacy reply, kept until someone resolves it
  sender_id uuid,
  legacy_created_at timestamptz,
  task_id uuid,
  project_id uuid,
  job_card_id uuid,
  reason text not null,
  suggested_destination text,
  status text not null default 'open' check (status in ('open', 'resolved')),
  detected_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.chat_legacy_runs (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  report jsonb not null
);

alter table public.chat_legacy_audit enable row level security;
alter table public.chat_legacy_review enable row level security;
alter table public.chat_legacy_runs enable row level security;
revoke all on public.chat_legacy_audit, public.chat_legacy_review, public.chat_legacy_runs from anon, authenticated;
-- only authorized Management / super admin may read them (no write policy: only SECURITY DEFINER code writes)
drop policy if exists chat_legacy_audit_mgmt on public.chat_legacy_audit;
drop policy if exists chat_legacy_review_mgmt on public.chat_legacy_review;
drop policy if exists chat_legacy_runs_mgmt on public.chat_legacy_runs;
create policy chat_legacy_audit_mgmt on public.chat_legacy_audit for select to authenticated using (public.staff_is_management() or public.staff_is_super_admin());
create policy chat_legacy_review_mgmt on public.chat_legacy_review for select to authenticated using (public.staff_is_management() or public.staff_is_super_admin());
create policy chat_legacy_runs_mgmt on public.chat_legacy_runs for select to authenticated using (public.staff_is_management() or public.staff_is_super_admin());
grant select on public.chat_legacy_audit, public.chat_legacy_review, public.chat_legacy_runs to authenticated;
