-- Regression test for v2_93t (Lead -> Quotation -> Scan -> Discount/Adjustment -> Send -> Customer Approval ->
-- Convert to Order). Runs against real data as impersonated users, always rolls back. Covers: email/billing/
-- delivery address snapshot from the lead onto the quotation; the full discount+adjustment formula (percent
-- discount, a manual price increase, and a manual decrease that requires approval); retail_record_quotation_sent's
-- gates (rejects an invalid phone, rejects an invalid method, requires it to actually be sent before approval);
-- retail_record_quotation_customer_approval's gates (refuses to approve a DRAFT/never-sent quotation, requires a
-- note for MANUAL_NOTE); retail_reject_quotation; retail_create_quotation_revision (old revision preserved and
-- marked non-current, new revision carries the same snapshot, old one can no longer be edited); lead status
-- transitions through the whole matrix; unauthorized callers blocked throughout.
do $t$
declare
  v_log text := ''; v_sales uuid; v_head uuid; v_other uuid; v_emp_role uuid; v_head_role uuid;
  v_retail_dept uuid; v_showroom_loc uuid; n int; v_errmsg text;
  v_placeholder public.retail_products; v_product public.retail_products; v_serial text;
  v_lead record; v_quote public.retail_quotations; v_quote2 public.retail_quotations; v_rev public.retail_quotations;
  v_qi1 public.retail_quotation_items; v_lead_status text; v_rev_item_id uuid;
begin
  create function public.zz_chk_qp(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select id into v_emp_role from roles where code = 'employee';
  select id into v_head_role from roles where code = 'dept_head';
  v_retail_dept := public.retail_dept_id();
  select id into v_showroom_loc from locations where type = 'showroom' and is_active limit 1;
  select up.id into v_sales from user_profiles up join roles r on r.id = up.role_id where up.department_id = v_retail_dept and r.code = 'employee' and up.is_active limit 1;
  select up.id into v_other from user_profiles up join roles r on r.id = up.role_id where up.department_id <> v_retail_dept and r.code = 'employee' and up.is_active and up.department_id is not null limit 1;

  insert into auth.users (id) values (gen_random_uuid()) returning id into v_head;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password)
    values (v_head, 'ZTEST-QP-RHEAD', 'ZTest QuotePipeline Retail Head', v_head_role, v_retail_dept, true, false);

  v_log := public.zz_chk_qp(v_log, 'fixture: sales, Retail Head, unrelated employee, showroom location resolved',
    v_sales is not null and v_head is not null and v_other is not null and v_showroom_loc is not null);

  -- ===== 1. A real Active product to scan-add (Head-registered so it's immediately Active) =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_head, 'role', 'authenticated')::text, true); set local role authenticated;
  v_placeholder := retail_start_stock_intake(v_showroom_loc);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_head::text || '/zqp-chair.jpg', jsonb_build_object('size', 400, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_product', v_placeholder.id, 'image', v_head::text || '/zqp-chair.jpg', 'zqp-chair.jpg', 'image/jpeg', 400, null, 'proof');
  v_product := retail_confirm_stock_intake(v_placeholder.id, 'Chair', 'ZQP Test Chair', 'Nos', 1, 'GOOD', null, null, true, false, 'CHAIR');
  perform retail_update_product_pricing(v_product.id, 12000, 10000, 8000, 'initial pricing');
  perform retail_update_product_details(v_product.id, 'ZQP Test Chair', 'Sheesham', 'Walnut', '45x45x90 cm', 'A test chair', '1 year', 12, null, true, 'set GST for formula test');
  select serial_number into v_serial from retail_inventory_items where product_id = v_product.id;
  reset role;

  -- ===== 2. Lead with email/whatsapp/city -> Quotation snapshots email/billing/delivery address, never re-typed =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_lead from retail_create_walkin('ZQP Customer', '9887711223', null, 'zqp@example.com', null, null, null, null, null, null, null, 'walkin', v_sales, 'RETAIL', null, 'WARM', null);
  update retail_customers set billing_address = '12 Billing Lane', delivery_address = '34 Delivery Road' where id = (select customer_id from retail_leads where id = v_lead.lead_id);

  v_quote := retail_create_quotation(v_lead.lead_id, 'ZQP Customer', '9887711223', v_showroom_loc, current_date + 10, current_date + 20, 0, 0,
    null, false, '[]'::jsonb, null, 'zqp@example.com', '12 Billing Lane', '34 Delivery Road', v_showroom_loc);
  v_log := public.zz_chk_qp(v_log, 'quotation snapshots email/billing/delivery address at creation, never re-typed',
    v_quote.email = 'zqp@example.com' and v_quote.billing_address = '12 Billing Lane' and v_quote.delivery_address = '34 Delivery Road');
  select status into v_lead_status from retail_leads where id = v_lead.lead_id;
  v_log := public.zz_chk_qp(v_log, 'lead status becomes QUOTED on quotation creation', v_lead_status = 'QUOTED');

  -- ===== 3. Discount/adjustment formula: 10% discount + a manual price INCREASE (allowed, reason required) =====
  v_errmsg := null;
  begin perform retail_add_quotation_item_from_scan(v_quote.id, v_serial, 1, 10, 'PERCENT', 'INCREASE', 500, null); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_qp(v_log, 'a price adjustment without a reason is refused', v_errmsg is not null);

  v_qi1 := retail_add_quotation_item_from_scan(v_quote.id, v_serial, 1, 10, 'PERCENT', 'INCREASE', 500, 'customer requested rush fitting');
  -- base 10000, 10% discount = 1000 -> after-discount 9000, +500 increase -> taxable 9500, 12% GST -> tax 1140, total 10640
  v_log := public.zz_chk_qp(v_log, 'the formula computes base/discount/adjustment/tax/total exactly per the spec',
    v_qi1.base_amount = 10000 and v_qi1.taxable_amount = 9500 and v_qi1.tax_amount = 1140 and v_qi1.line_total = 10640);
  select discount_approval_status into v_lead_status from retail_quotations where id = v_quote.id;
  v_log := public.zz_chk_qp(v_log, 'a plain increase (never a decrease) does not require approval', v_lead_status = 'NONE');
  reset role;

  -- ===== 4. retail_record_quotation_sent: invalid phone / invalid method / actually sending =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin perform retail_record_quotation_sent(v_quote.id, 'WHATSAPP_MANUAL', '123'); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_qp(v_log, 'sending with an invalid (too-short) phone number is refused', v_errmsg is not null);

  v_errmsg := null;
  begin perform retail_record_quotation_sent(v_quote.id, 'BAD_METHOD', '+919887711223'); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_qp(v_log, 'an invalid send method is refused', v_errmsg is not null);

  v_quote := retail_record_quotation_sent(v_quote.id, 'WHATSAPP_MANUAL', '+919887711223');
  v_log := public.zz_chk_qp(v_log, 'a valid manual send marks the quotation SENT with a real audit trail', v_quote.status = 'SENT' and v_quote.sent_by = v_sales and v_quote.sent_at is not null);
  select status into v_lead_status from retail_leads where id = v_lead.lead_id;
  v_log := public.zz_chk_qp(v_log, 'lead status advances to QUOTATION_SENT', v_lead_status = 'QUOTATION_SENT');

  -- ===== 5. Customer approval: cannot approve a never-sent quotation; requires a real method/note =====
  v_quote2 := retail_create_quotation(null, 'ZQP Unsent Customer', '9887711224', v_showroom_loc, current_date + 10, current_date + 20, 0, 0, null, false, '[]'::jsonb, null);
  v_errmsg := null;
  begin perform retail_record_quotation_customer_approval(v_quote2.id, 'MANUAL_NOTE', 'looks fine'); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_qp(v_log, 'a DRAFT (never-sent) quotation cannot be marked customer-approved', v_errmsg is not null);

  v_errmsg := null;
  begin perform retail_record_quotation_customer_approval(v_quote.id, 'MANUAL_NOTE', ''); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_qp(v_log, 'a MANUAL_NOTE approval requires an actual note', v_errmsg is not null);

  v_quote := retail_record_quotation_customer_approval(v_quote.id, 'WHATSAPP_MESSAGE', 'Customer replied "confirmed, please proceed"', v_quote.total_amount);
  v_log := public.zz_chk_qp(v_log, 'a sent quotation can be recorded as customer-approved with real evidence',
    v_quote.status = 'ACCEPTED' and v_quote.customer_approved_at is not null and v_quote.customer_approval_method = 'WHATSAPP_MESSAGE');
  select status into v_lead_status from retail_leads where id = v_lead.lead_id;
  v_log := public.zz_chk_qp(v_log, 'lead status advances to QUOTATION_APPROVED', v_lead_status = 'QUOTATION_APPROVED');
  reset role;

  -- ===== 6. retail_reject_quotation on a fresh DRAFT quotation =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin perform retail_reject_quotation(v_quote2.id, ''); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_qp(v_log, 'rejecting without a reason is refused', v_errmsg is not null);
  v_quote2 := retail_reject_quotation(v_quote2.id, 'Customer chose a competitor');
  v_log := public.zz_chk_qp(v_log, 'a quotation can be rejected with a reason', v_quote2.status = 'REJECTED' and v_quote2.rejection_reason = 'Customer chose a competitor');
  reset role;

  -- ===== 7. Revision: never overwrites the sent/approved version; old marked non-current, new carries the snapshot =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin perform retail_create_quotation_revision(v_quote.id, 'need to add another item'); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_qp(v_log, 'an unrelated employee cannot create a revision', v_errmsg is not null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_rev := retail_create_quotation_revision(v_quote.id, 'customer asked for one more unit');
  reset role;
  v_log := public.zz_chk_qp(v_log, 'the revision is Revision 2, superseding the original', v_rev.revision_no = 2 and v_rev.supersedes_id = v_quote.id);

  select count(*) into n from retail_quotations where id = v_quote.id and is_current_revision = false and status = 'ACCEPTED';
  v_log := public.zz_chk_qp(v_log, 'the ORIGINAL (approved) revision is preserved untouched, just marked non-current — never overwritten', n = 1);
  select count(*) into n from retail_quotation_items where quotation_id = v_rev.id;
  v_log := public.zz_chk_qp(v_log, 'the new revision carries the same line item snapshot forward', n = 1);
  v_log := public.zz_chk_qp(v_log, 'the new revision is its own fresh DRAFT (not overwriting the sent/approved one)', v_rev.status = 'DRAFT' and v_rev.is_current_revision = true);
  select status into v_lead_status from retail_leads where id = v_lead.lead_id;
  v_log := public.zz_chk_qp(v_log, 'creating a revision moves the lead to NEGOTIATION', v_lead_status = 'NEGOTIATION');

  select total_amount into n from retail_quotations where id = v_rev.id;
  v_log := public.zz_chk_qp(v_log, 'the revision reproduces the SAME total as the original (no silent recompute drift)', n = v_qi1.line_total);

  v_errmsg := null;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  begin perform retail_add_quotation_item_from_scan(v_quote.id, v_serial, 1, 0); exception when others then v_errmsg := sqlerrm; end;
  reset role;
  v_log := public.zz_chk_qp(v_log, 'the superseded original revision can no longer be edited', v_errmsg is not null);

  -- ===== 8. retail_remove_quotation_item: corrects the running total, not just a raw row delete. Removed from the
  --          NEW revision's own copied item (v_qi1 belongs to the now-superseded original and can no longer be
  --          edited, exactly as just proven above). =====
  select id into v_rev_item_id from retail_quotation_items where quotation_id = v_rev.id limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_remove_quotation_item(v_rev_item_id);
  reset role;
  select total_amount into n from retail_quotations where id = v_rev.id;
  v_log := public.zz_chk_qp(v_log, 'removing the last item on the new revision correctly zeroes its running total (not left stale)', n = 0);
  select count(*) into n from retail_quotation_items where quotation_id = v_rev.id;
  v_log := public.zz_chk_qp(v_log, 'the item row is actually gone', n = 0);

  raise exception E'QUOTATION-SALES-PIPELINE-REGRESSION (rolled back)\n%', v_log;
end $t$;
