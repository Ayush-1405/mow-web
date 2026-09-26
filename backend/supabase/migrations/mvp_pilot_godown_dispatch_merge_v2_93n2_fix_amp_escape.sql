-- The apply_migration transport HTML-entity-escaped the ampersand in 93n's UPDATE ("&" -> "&amp;") when it was
-- first applied live. Caught immediately via a live re-read and fixed live; recorded here so the migration
-- history on disk matches exactly what the live database now holds.
update public.departments set name_en = 'Godown, Inventory & Dispatch'
where code = 'GODOWN_INV' and name_en = 'Godown, Inventory &amp; Dispatch';
