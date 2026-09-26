-- v2_93l2 -- hotfix: staff_attachments has its OWN check constraint restricting entity_type to ('task','bridge'), separate from and
-- in addition to staff_record_attachment()'s own if/elsif validation extended in v2_93l. Confirmed live: the v2_93l branches for
-- 'retail_packing'/'retail_godown_handover'/etc. pass their own validation but then fail INSERT with
-- "violates check constraint staff_attachments_entity_type_check". Widen the constraint to match (additive only).
alter table public.staff_attachments drop constraint if exists staff_attachments_entity_type_check;
alter table public.staff_attachments add constraint staff_attachments_entity_type_check check (entity_type = any (array[
  'task', 'bridge', 'retail_packing', 'retail_godown_handover', 'retail_dispatch', 'retail_delivery', 'retail_installation'
]));
