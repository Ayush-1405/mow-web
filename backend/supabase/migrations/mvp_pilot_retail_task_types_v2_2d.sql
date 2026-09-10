-- Mood of Wood — Staff Pilot — Retail Stock Transfer / Delivery task types.
--
-- Adds two lookup rows to the existing task_types table so the Retail
-- "Stock Transfer Requests" and "Delivery Coordination" cards can filter
-- the already-working staff_tasks/bridges engine down to just their own
-- kind of cross-department request, instead of duplicating that workflow
-- with new tables. Purely additive seed data — no schema change, no
-- existing row touched. Safe to run twice (ON CONFLICT DO NOTHING).
INSERT INTO public.task_types (code, name_en, name_gu, department_id, is_active)
VALUES
  ('STOCK_TRANSFER', 'Stock Transfer', 'સ્ટોક ટ્રાન્સફર', NULL, true),
  ('DELIVERY', 'Delivery', 'ડિલિવરી', NULL, true)
ON CONFLICT (code) DO NOTHING;
