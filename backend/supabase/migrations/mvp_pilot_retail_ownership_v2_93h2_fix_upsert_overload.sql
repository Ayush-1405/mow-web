-- v2_93h2 -- hotfix: v2_93h added a new trailing parameter (p_salesperson_id) to retail_upsert_customer via CREATE OR REPLACE.
-- Postgres identifies functions by name + full argument type list, so adding a parameter does NOT replace the old function -- it
-- creates a SECOND overload alongside it. Any caller that still passes exactly the original 7 positional arguments (e.g.
-- retail_import_leads, from v2_93e) then becomes ambiguous: both the 7-arg original and the 8-arg version (with its 8th argument
-- defaulted) match, and Postgres refuses to guess ("function ... is not unique"). Confirmed live by retail_import_reports.sql failing
-- with exactly that error after v2_93h. Fix: drop the old 7-arg overload explicitly, leaving only the 8-arg version from v2_93h.
drop function if exists public.retail_upsert_customer(text, text, text, text, text, text, text);
