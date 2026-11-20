-- Run after live-schema.sql, aargon3-2.0.sql, checks.sql and aargon3-2.1.sql (twice).
\set ON_ERROR_STOP on
do $$
declare r jsonb; u1 uuid := '11111111-1111-1111-1111-111111111111'; u3 uuid := '33333333-3333-3333-3333-333333333333'; n bigint; sid bigint;
begin
  -- staff: Nexus admins join automatically; the owner email is always owner; others need an invite
  r := a3_staff_sync(u1, 'ApojiDelegraphics101010@gmail.com', 'Lucas', 'admin', true);
  assert r->>'role' = 'owner' and r->>'email' = 'apojidelegraphics101010@gmail.com', 'owner sync: ' || r::text;
  r := a3_staff_sync(u3, 'sam@co.com', 'Sam', null, false); assert r is null, 'non-admin got in';
  r := a3_staff_save('{"email":"Sam@co.com","role":"employee","pay_rate":"15.5","title":"Associate"}', 'Lucas');
  assert r->>'role' = 'employee' and (r->>'pay_rate')::numeric = 15.5, 'invite';
  begin perform a3_staff_save('{"email":"sam@co.com"}', 'Lucas'); assert false, 'dupe invite'; exception when others then assert sqlerrm like '%already%', sqlerrm; end;
  r := a3_staff_sync(u3, 'sam@co.com', 'Sammy', null, false); assert r->>'user_id' = u3::text and r->>'name' = 'Associate' or r->>'nexus_name' = 'Sammy', 'invited sign-in: ' || r::text;
  r := a3_staff_save(jsonb_build_object('id', (r->>'id')::bigint, 'active', false), 'Lucas'); assert not (r->>'active')::boolean, 'deactivate';
  r := a3_staff_sync(u3, 'sam@co.com', 'Sammy', null, false); assert not (r->>'active')::boolean, 'still inactive after sign-in';
  r := a3_staff_save(jsonb_build_object('id', (r->>'id')::bigint, 'active', true), 'Lucas');
  -- someone else who held owner gets demoted when they sign in without the owner email
  update staff set role = 'owner' where user_id = u3;
  r := a3_staff_sync(u3, 'sam@co.com', 'Sammy', null, false); assert r->>'role' = 'manager', 'non-owner kept owner';
  assert jsonb_array_length(a3_staff_list(false)) = 2 and not (a3_staff_list(false)->0 ? 'pay_rate'), 'list hides pay';
  assert a3_staff_list(true)->0 ? 'pay_rate', 'owner sees pay';

  -- schedule → clock in knows the shift and lateness
  r := a3_schedule_save(jsonb_build_object('user_id', u1, 'store_code', '0028', 'starts_at', now() - interval '20 minutes', 'ends_at', now() + interval '7 hours'), 'Lucas');
  sid := (r->>'id')::bigint;
  begin perform a3_schedule_save(jsonb_build_object('user_id', u1, 'starts_at', now(), 'ends_at', now() + interval '1 hour'), 'Lucas'); assert false, 'overlap'; exception when others then assert sqlerrm like '%overlaps%', sqlerrm; end;
  begin perform a3_schedule_save(jsonb_build_object('user_id', '99999999-9999-9999-9999-999999999999', 'starts_at', now(), 'ends_at', now() + interval '1 hour'), 'Lucas'); assert false, 'unknown person'; exception when others then assert sqlerrm like '%signed in%', sqlerrm; end;
  begin perform a3_schedule_save(jsonb_build_object('user_id', u3, 'starts_at', now(), 'ends_at', now() + interval '20 hours'), 'Lucas'); assert false, 'too long'; exception when others then assert sqlerrm like '%16 hours%', sqlerrm; end;
  r := a3_clock_in(u1, 'Lucas', '0028');
  assert (r->>'scheduled_id')::bigint = sid and (r->>'late_minutes')::int between 19 and 21, 'late: ' || r::text;
  assert jsonb_array_length(a3_staff_state(u1)->'upcoming') = 1, 'upcoming';
  assert (a3_schedule(now() - interval '1 day', now() + interval '1 day')->0->>'name') = 'Lucas', 'schedule names';
  assert a3_schedule_copy_week(now() - interval '1 day', 'Lucas') = 1, 'copy week';
  assert a3_schedule_copy_week(now() - interval '1 day', 'Lucas') = 0, 'copy week twice';
  update shifts set clock_in = now() - interval '10 minutes' where user_id = u1 and clock_out is null;   -- one transaction: now() doesn't move
  perform a3_clock_out(u1, null, null);

  -- time off
  r := a3_timeoff_request(u3, current_date + 3, current_date + 4, 'Trip');
  assert (a3_staff_state(u1)->>'pending_time_off')::int = 1, 'pending count';
  begin perform a3_timeoff_decide((r->>'id')::bigint, 'approved', 'Sam', u3); assert false, 'self-approve'; exception when others then null; end;
  r := a3_timeoff_decide((r->>'id')::bigint, 'approved', 'Lucas'); assert r->>'status' = 'approved', 'approve';
  r := a3_schedule_save(jsonb_build_object('user_id', u3, 'starts_at', ((current_date + 3)::timestamp + interval '15 hours') at time zone 'America/New_York',
          'ends_at', ((current_date + 3)::timestamp + interval '20 hours') at time zone 'America/New_York'), 'Lucas');
  assert (select (x->>'time_off')::boolean from jsonb_array_elements(a3_schedule(now(), now() + interval '10 days', u3)) x limit 1), 'time-off flag on schedule';

  -- quotes → custom order paid by invoice, with company details; payments and renewals
  r := a3_quote_save(jsonb_build_object('quote_no', 'Q-TEST01', 'plan', 'enterprise', 'tier', 'max', 'seats', 400, 'interval', 'year', 'amount_cents', 1200000,
         'customer', '{"company":"Acme"}', 'created_by', 'Lucas'));
  assert r->>'status' = 'draft' and (r->>'amount')::numeric = 12000, 'quote';
  r := a3_quote_save('{"quote_no":"Q-TEST01","status":"sent","stripe_invoice_id":"in_1","delivery":"invoice"}');
  r := a3_record_order(jsonb_build_object('order_id', 'ENTRPRS1-QQQQ', 'stripe_invoice_id', 'in_1', 'first_invoice_id', 'in_1', 'stripe_subscription_id', 'sub_ent',
        'plan_type', 'Enterprise', 'tier', 'max', 'billing', 'year', 'amount_cents', 1200000, 'seats', 400, 'quote_no', 'Q-TEST01', 'source', 'custom',
        'company_name', 'Acme Corp', 'customer_name', 'Pat Lee', 'customer_phone', '555-0100', 'node_id', 'NODE-1', 'target_jurisdiction', 'North Carolina',
        'customer_info', '{"company":"Acme Corp","role":"CTO"}'));
  assert (r->>'created')::boolean, 'enterprise order';
  r := a3_record_order(jsonb_build_object('order_id', 'DUPE0000-0000', 'stripe_invoice_id', 'in_1')); assert r->>'order_id' = 'ENTRPRS1-QQQQ', 'invoice dedupe';
  assert (a3_quote('q-test01')->>'status') = 'paid' and (a3_quote('Q-TEST01')->>'order_id') = 'ENTRPRS1-QQQQ', 'quote paid';
  begin perform a3_quote_save('{"quote_no":"Q-TEST01","status":"cancelled"}'); assert false, 'cancel paid quote'; exception when others then assert sqlerrm like '%already paid%', sqlerrm; end;
  r := a3_record_payment('in_2', 'sub_ent', 1200000); assert (r->>'recorded')::boolean, 'renewal';
  r := a3_record_payment('in_2', 'sub_ent', 1200000); select count(*) into n from payments where stripe_invoice_id = 'in_2'; assert n = 1, 'renewal dedupe';
  assert (a3_record_payment('in_x', 'sub_unknown', 100)->>'recorded')::boolean = false, 'unknown sub';
  r := a3_orders('acme', 10); assert jsonb_array_length(r) = 1 and r->0->>'company_name' = 'Acme Corp' and (r->0->>'paid_total')::numeric = 24000, 'search company: ' || r::text;
  assert jsonb_array_length(a3_orders('Q-TEST', 10)) = 1, 'search quote';

  -- sales
  r := a3_sales();
  -- 149 (2.0 checks order, cancelled but paid) + 24000 (enterprise first + renewal) + 4107.94 (legacy) + 0 (non-numeric legacy)
  assert round((r->'all_time'->>'revenue')::numeric, 2) = 28256.94, 'all-time revenue: ' || (r->'all_time'->>'revenue');
  assert jsonb_array_length(r->'months') = 12, 'months';
  assert (r->>'mrr')::numeric = 1000, 'mrr: ' || (r->>'mrr');
  assert (r->'all_time'->>'renewals')::int = 1, 'renewals';
  assert (a3_sales('22222222-2222-2222-2222-222222222222')->'all_time'->>'orders')::int = 1, 'my sales';
  update orders set status = 'REFUNDED' where order_id = 'ENTRPRS1-QQQQ';
  assert round((a3_sales()->'all_time'->>'revenue')::numeric, 2) = 4256.94, 'refund excluded';

  -- promotions
  r := a3_promo_save('{"code":"launch20","type":"percentage","value":20,"duration":"once","plans":["personal","business"],"limit":2,"created_by":"Lucas"}');
  assert r->>'code' = 'LAUNCH20' and (r->>'live')::boolean, 'promo';
  begin perform a3_promo_save('{"code":"launch20","type":"fixed","value":5}'); assert false, 'dupe promo'; exception when others then assert sqlerrm like '%already exists%', sqlerrm; end;
  begin perform a3_promo_save('{"code":"x","type":"fixed","value":5}'); assert false, 'short code'; exception when others then null; end;
  perform a3_record_order('{"order_id":"PROMO000-0001","stripe_session_id":"cs_p1","promo_code":"launch20","amount_cents":480,"discount_cents":120}');
  perform a3_record_order('{"order_id":"PROMO000-0002","stripe_session_id":"cs_p2","promo_code":"launch20","amount_cents":480}');
  r := a3_promo('launch20'); assert (r->>'used')::int = 2 and not (r->>'live')::boolean, 'promo used up: ' || r::text;
  assert (select discount_amount from orders where order_id = 'PROMO000-0001') = 1.2, 'discount stored';
  r := a3_promo_save(jsonb_build_object('id', (r->>'id')::bigint, 'active', false)); assert not (r->>'active')::boolean, 'promo off';

  -- settings and stores
  r := a3_setting_set('store', '{"open":false,"message":"Back Monday"}', 'Lucas'); assert r->'store'->>'open' = 'false', 'store closed';
  begin perform a3_setting_set('hack', '{}', 'x'); assert false, 'unknown setting'; exception when others then null; end;
  r := a3_store_save('7777', 'Test Outpost', 'b', true); assert r->>'region' = 'B', 'store add';
  r := a3_store_save('7777', '', 'B', false); assert r->>'name' = 'Test Outpost' and r->>'active' = 'false', 'store disable keeps name';
  begin perform a3_store_save('77', 'x', 'A', true); assert false, 'bad code'; exception when others then null; end;
end $$;

set role anon;
do $$ begin
  begin perform * from staff; assert false, 'anon read staff'; exception when insufficient_privilege then null; end;
  begin perform * from quotes; assert false, 'anon read quotes'; exception when insufficient_privilege then null; end;
  begin perform * from payments; assert false, 'anon read payments'; exception when insufficient_privilege then null; end;
  begin perform * from settings; assert false, 'anon read settings'; exception when insufficient_privilege then null; end;
  begin perform * from schedule; assert false, 'anon read schedule'; exception when insufficient_privilege then null; end;
  begin perform company_name from orders; assert false, 'anon read company'; exception when insufficient_privilege then null; end;
  begin perform a3_sales(); assert false, 'anon sales'; exception when insufficient_privilege then null; end;
  begin perform a3_staff_sync('11111111-1111-1111-1111-111111111111', 'x@y.z', 'x', 'high-admin', true); assert false, 'anon staff sync'; exception when insufficient_privilege then null; end;
  perform order_id, plan_type, status, config, items from orders limit 1;   -- Nexus still works
end $$;
reset role;
select 'ALL 2.1 CHECKS PASSED' as result;
