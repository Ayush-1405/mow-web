-- Mood of Wood — MVP Pilot — pin search_path on trigger functions.
--
-- NOT YET APPLIED to the live project as of 2026-09-06. Ready to run via
-- `supabase db push` (or apply_migration) once reviewed.
--
-- Supabase's security linter (0011_function_search_path_mutable) flags
-- these five functions because they were created without an explicit
-- search_path, leaving them to resolve unqualified object names using
-- whatever search_path the calling session/role has set. All five are
-- trigger functions (no arguments, plpgsql, SECURITY INVOKER — confirmed
-- against pg_proc before writing this), so the practical risk here is low,
-- but pinning search_path is a standard, additive hardening step recommended
-- by Postgres/Supabase for every function regardless of privilege level.
--
-- pg_catalog is listed first so built-in types/operators always resolve to
-- the real ones; public is listed second so these functions keep finding
-- the same application tables/types they already reference unqualified.
alter function public.project_materials_touch_updated_at() set search_path = pg_catalog, public;
alter function public.staff_generate_task_number() set search_path = pg_catalog, public;
alter function public.staff_generate_bridge_number() set search_path = pg_catalog, public;
alter function public.staff_touch_updated_at() set search_path = pg_catalog, public;
alter function public.staff_validate_task_transition() set search_path = pg_catalog, public;
