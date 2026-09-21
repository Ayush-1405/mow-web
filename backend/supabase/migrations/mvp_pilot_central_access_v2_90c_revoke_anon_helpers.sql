-- v2_90c -- the two pure role-normalisation helpers need no anonymous access (they are only ever called from policies / functions run by signed-in users).
revoke execute on function public.staff_norm_role(text), public.staff_role_family(text) from public, anon;
grant execute on function public.staff_norm_role(text), public.staff_role_family(text) to authenticated;
