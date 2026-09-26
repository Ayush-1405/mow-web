-- Advisory fix (found during final security-advisor sweep, not previously flagged): retail_normalize_phone had no explicit
-- search_path, which the linter flags as "mutable search_path" -- a caller-controlled search_path could in principle shadow the
-- built-ins this function relies on (regexp_replace/right/nullif/coalesce). Harmless in practice (all built-ins, no table access)
-- but free and correct to close.
create or replace function public.retail_normalize_phone(p text)
returns text
language sql
immutable
set search_path = public
as $function$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10), '');
$function$;
