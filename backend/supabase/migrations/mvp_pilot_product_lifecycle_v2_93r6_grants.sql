-- Follow-up: RLS policies were added for these tables in v2_93q/v2_93r, but the base table-level GRANT SELECT to
-- authenticated was missed -- a Postgres RLS policy is only ever consulted AFTER the underlying GRANT permits the
-- operation at all, so direct client reads were silently refused with "permission denied" regardless of the policy.
-- Caught while testing retail_delivery_challan_items directly. Read-only: every write to any of these tables already
-- goes through a SECURITY DEFINER RPC, so no INSERT/UPDATE/DELETE grant is added.
grant select on public.retail_product_types to authenticated;
grant select on public.retail_product_price_history to authenticated;
grant select on public.retail_inventory_items to authenticated;
grant select on public.retail_delivery_challans to authenticated;
grant select on public.retail_delivery_challan_items to authenticated;
grant select on public.retail_stock_movements to authenticated;
