-- Same HTML-entity-escaping artifact as 93n2, this time in the staff_audit_log row 93n itself inserted. Fixed live;
-- recorded here for migration-history consistency.
update staff_audit_log set new_value = jsonb_build_object('name_en', 'Godown, Inventory & Dispatch', 'merged_department_code', 'DISPATCH')
where entity_type = 'department' and action = 'MERGE' and new_value->>'name_en' = 'Godown, Inventory &amp; Dispatch';
