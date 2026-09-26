-- Regression test for v2_93o (Godown stock intake: photo -> auto product code). Runs against real data as
-- impersonated users, always rolls back. Covers: retail_start_stock_intake creates exactly one product+stock row;
-- confirming refuses without a photo; confirming succeeds and generates a real, category-prefixed SKU; a second
-- intake in the same category gets the next sequence number; an unrelated (non-Godown) employee cannot start or
-- confirm an intake.
do $t$
declare
  v_log text := ''; v_godown uuid; v_other uuid; v_head_role uuid; v_godown_dept uuid; v_loc uuid;
  v_product1 public.retail_products; v_product2 public.retail_products; v_att_id uuid; v_errmsg text; n int;
begin
  create function public.zz_chk_stock(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select id into v_head_role from roles where code = 'dept_head';
  v_godown_dept := public.retail_godown_dept_id();
  select up.id into v_other from user_profiles up join roles r on r.id=up.role_id where up.department_id <> v_godown_dept and r.code='employee' and up.is_active and up.department_id is not null limit 1;
  select id into v_loc from locations where is_active limit 1;

  insert into auth.users (id) values (gen_random_uuid()) returning id into v_godown;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password)
    values (v_godown, 'ZTEST-STK', 'ZTest Stock Intake Worker', v_head_role, v_godown_dept, true, false);

  v_log := public.zz_chk_stock(v_log, 'fixture: fabricated Godown worker, unrelated employee, location resolved', v_godown is not null and v_other is not null and v_loc is not null);

  -- an unrelated employee cannot start an intake
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_start_stock_intake(v_loc);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_stock(v_log, 'an unrelated employee cannot start a stock intake', v_errmsg is not null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_godown, 'role', 'authenticated')::text, true); set local role authenticated;
  v_product1 := retail_start_stock_intake(v_loc);
  v_log := public.zz_chk_stock(v_log, 'starting an intake creates a placeholder product row', v_product1.id is not null and v_product1.sku like 'PENDING-%');
  select count(*) into n from retail_stock where product_id = v_product1.id;
  v_log := public.zz_chk_stock(v_log, 'exactly one stock row was created for the placeholder product', n = 1);

  -- confirming without a photo is refused
  v_errmsg := null;
  begin
    perform retail_confirm_stock_intake(v_product1.id, 'Chair', 'Wooden Dining Chair', 'Nos', 4);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_stock(v_log, 'confirming is refused before a photo is uploaded', v_errmsg is not null);
  reset role;

  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown::text || '/zstk-1.jpg', jsonb_build_object('size', 500, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown, 'role', 'authenticated')::text, true); set local role authenticated;
  v_att_id := staff_record_attachment('retail_product', v_product1.id, 'image', v_godown::text || '/zstk-1.jpg', 'zstk-1.jpg', 'image/jpeg', 500, null, 'proof');
  v_log := public.zz_chk_stock(v_log, 'the item photo was recorded as a real staff_attachments row', v_att_id is not null);

  v_product1 := retail_confirm_stock_intake(v_product1.id, 'Chair', 'Wooden Dining Chair', 'Nos', 4);
  v_log := public.zz_chk_stock(v_log, 'confirming generates a real, category-prefixed SKU', v_product1.sku = 'CHAI-001');
  v_log := public.zz_chk_stock(v_log, 'confirming sets the image_path to the photo attachment id', v_product1.image_path = v_att_id::text);
  select on_hand_qty into n from retail_stock where product_id = v_product1.id;
  v_log := public.zz_chk_stock(v_log, 'confirming sets the on-hand quantity', n = 4);

  -- a second intake in the same category gets the next sequence number
  v_product2 := retail_start_stock_intake(v_loc);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown::text || '/zstk-2.jpg', jsonb_build_object('size', 500, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_product', v_product2.id, 'image', v_godown::text || '/zstk-2.jpg', 'zstk-2.jpg', 'image/jpeg', 500, null, 'proof');
  v_product2 := retail_confirm_stock_intake(v_product2.id, 'chair', 'Plastic Chair', 'Nos', 10);
  v_log := public.zz_chk_stock(v_log, 'a second item in the same category gets the next sequence number', v_product2.sku = 'CHAI-002');
  reset role;

  -- an unrelated employee cannot confirm someone else's intake either
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_confirm_stock_intake(v_product2.id, 'chair', 'Hijacked', 'Nos', 1);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_stock(v_log, 'an unrelated employee cannot confirm someone else''s intake', v_errmsg is not null);
  reset role;

  raise exception E'STOCK-INTAKE-REGRESSION (rolled back)\n%', v_log;
end $t$;
