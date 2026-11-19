-- Run after live-schema.sql and aargon3-2.0.sql (twice). Any failed check raises an error.
\set ON_ERROR_STOP on
do $$
declare r jsonb; s jsonb; u1 uuid := '11111111-1111-1111-1111-111111111111'; u2 uuid := '22222222-2222-2222-2222-222222222222'; n int; ok boolean;
begin
  -- stores seeded once, even though the migration ran twice
  select count(*) into n from stores; assert n = 33, 'expected 33 stores, got ' || n;
  -- the old open shift with no account was closed
  select count(*) into n from shifts where clock_out is null; assert n = 0, 'legacy open shift not closed';

  -- clock in / break / clock out
  r := a3_clock_in(u1, 'Lucas', '0028');
  assert r->>'store' = 'Store #0028 – Neo Silicon Valley Flagship (Hub Zero)', 'store name: ' || (r->>'store');
  begin perform a3_clock_in(u1, 'Lucas', '0028'); assert false, 'double clock-in allowed'; exception when others then assert sqlerrm like '%already clocked in%', sqlerrm; end;
  begin perform a3_clock_in(u2, 'Sam', 'nope'); assert false, 'bad store allowed'; exception when others then assert sqlerrm like '%Pick a store%', sqlerrm; end;
  r := a3_break(u1, true); assert (r->>'on_break')::boolean, 'not on break';
  begin perform a3_break(u1, true); assert false, 'double break'; exception when others then assert sqlerrm like '%already on a break%', sqlerrm; end;
  r := a3_break(u1, false); assert not (r->>'on_break')::boolean, 'still on break';
  s := a3_staff_state(u1); assert s->'shift'->>'id' is not null, 'state has no shift'; assert jsonb_array_length(s->'stores') = 33, 'state stores';

  -- pretend the shift started 3 hours ago with a 30 minute break, then clock out "forgot" 1 hour ago
  update shifts set clock_in = now() - interval '3 hours', breaks = jsonb_build_array(jsonb_build_object('start', now() - interval '2 hours', 'end', now() - interval '90 minutes'))
   where user_id = u1 and clock_out is null;
  begin perform a3_clock_out(u1, null, now() - interval '5 hours'); assert false, 'clock-out before clock-in'; exception when others then assert sqlerrm like '%outside your shift%', sqlerrm; end;
  r := a3_clock_out(u1, 'Left at 4', now() - interval '1 hour');
  assert (r->>'forgot')::boolean, 'forgot flag'; assert (r->>'minutes')::int between 89 and 91, 'minutes: ' || (r->>'minutes');
  begin perform a3_clock_out(u1, null, null); assert false, 'clock out twice'; exception when others then assert sqlerrm like '%not clocked in%', sqlerrm; end;
  assert (a3_staff_state(u1)->>'last_store') = '0028', 'last store';

  -- a sale on a shift
  r := a3_clock_in(u2, 'Sam', '0427');
  r := a3_record_order(jsonb_build_object('order_id', 'ABCDEFGH-JKLM', 'stripe_session_id', 'cs_test_1', 'plan_type', 'Business', 'tier', 'pro',
        'billing', 'month', 'config', '{"os":"LentOS 28 Horizon"}'::jsonb, 'items', '[{"model":"Lyte-28"}]'::jsonb, 'amount_cents', 14900,
        'customer_email', 'a@b.co', 'source', 'terminal', 'staff_user_id', u2, 'operator', 'Sam', 'shift_id', (r->>'id')));
  assert (r->>'created')::boolean, 'order not created';
  r := a3_record_order(jsonb_build_object('order_id', 'ZZZZZZZZ-ZZZZ', 'stripe_session_id', 'cs_test_1'));   -- webhook retried
  assert r->>'order_id' = 'ABCDEFGH-JKLM' and not (r->>'created')::boolean, 'webhook retry made a second order';
  select count(*) into n from orders where stripe_session_id = 'cs_test_1'; assert n = 1, 'duplicate orders';
  assert (select total_orders from shifts where user_id = u2 and clock_out is null) = 1, 'shift order count';
  assert (select total_sales from shifts where user_id = u2 and clock_out is null) = 149, 'shift sales';
  assert (select total_price from orders where order_id = 'ABCDEFGH-JKLM') = '149.00', 'total_price text';
  assert (select store_name from orders where order_id = 'ABCDEFGH-JKLM') like 'Store #0427%', 'order store';
  assert (a3_order_by_session('cs_test_1')->>'order_id') = 'ABCDEFGH-JKLM', 'by session';
  assert jsonb_array_length(a3_orders('a@b', 10)) = 1, 'search by email';
  assert jsonb_array_length(a3_orders('', 10)) = 3, 'list all';
  assert (a3_order(' abcdefgh-jklm ')->>'amount')::numeric = 149, 'a3_order amount';
  assert (a3_orders('MUR3', 5)->0->>'amount')::numeric = 0, 'non-numeric legacy total';

  -- overview
  r := a3_overview();
  assert (r->'today'->>'orders')::int >= 1, 'overview orders'; assert jsonb_array_length(r->'week') = 7, 'overview week';
  assert jsonb_array_length(r->'on_clock') = 1, 'on clock';

  -- cancel by subscription
  update orders set stripe_subscription_id = 'sub_1' where order_id = 'ABCDEFGH-JKLM';
  assert a3_set_status(null, 'sub_1', 'cancelled') = 1, 'set status';
  assert (select status from orders where order_id = 'ABCDEFGH-JKLM') = 'CANCELLED', 'status';

  -- manager fix
  select id into n from shifts where user_id = u2 and clock_out is null;
  r := a3_edit_shift(n, now() - interval '2 hours', now(), 'fixed', 'Lucas');
  assert r->>'edited_by' = 'Lucas' and r->>'clock_out' is not null, 'edit shift';
  begin perform a3_edit_shift(n, now(), now() - interval '1 hour', null, 'x'); assert false, 'bad edit'; exception when others then assert sqlerrm like '%after clock-in%', sqlerrm; end;
  assert jsonb_array_length(a3_shifts(null, now() - interval '1 day', now() + interval '1 day')) = 2, 'team shifts';
  assert jsonb_array_length(a3_shifts(u1, now() - interval '1 day', now() + interval '1 day')) = 1, 'my shifts';
  perform a3_log(u1, 'Lucas', 'test', '{}'); assert jsonb_array_length(a3_log_list(10)) = 1, 'log';
end $$;

-- What the public key can and can't do
set role anon;
do $$
declare n int;
begin
  -- Nexus's exact lookup still works
  select count(*) into n from orders where order_id in ('MUR40KWU-4S6I'); assert n = 1, 'nexus lookup';
  perform order_id, plan_type, status, config, items from orders limit 1;
  begin perform customer_email from orders limit 1; assert false, 'anon read customer_email'; exception when insufficient_privilege then null; end;
  begin perform customer_name from orders limit 1; assert false, 'anon read customer_name'; exception when insufficient_privilege then null; end;
  begin insert into orders (order_id, status) values ('FREE0000-0000', 'ACTIVE'); assert false, 'anon inserted an order'; exception when insufficient_privilege then null; end;
  begin update orders set status = 'ACTIVE'; assert false, 'anon updated orders'; exception when insufficient_privilege then null; end;
  begin perform * from shifts; assert false, 'anon read shifts'; exception when insufficient_privilege then null; end;
  begin insert into shifts (employee_name, store_name) values ('x', 'y'); assert false, 'anon wrote shifts'; exception when insufficient_privilege then null; end;
  begin perform * from promotions; assert false, 'anon read promotions'; exception when insufficient_privilege then null; end;
  begin perform * from staff_log; assert false, 'anon read staff_log'; exception when insufficient_privilege then null; end;
  begin perform a3_overview(); assert false, 'anon called a3_overview'; exception when insufficient_privilege then null; end;
  begin perform a3_record_order('{}'); assert false, 'anon called a3_record_order'; exception when insufficient_privilege then null; end;
  begin perform a3_clock_in('11111111-1111-1111-1111-111111111111', 'x', '0028'); assert false, 'anon clocked in'; exception when insufficient_privilege then null; end;
  select count(*) into n from terms; assert n = 1, 'terms readable';
  begin insert into terms (content) values ('x'); assert false, 'anon wrote terms'; exception when insufficient_privilege then null; end;
  select orders into n from business_summary; assert n >= 1, 'business views still work';
end $$;
reset role;

set role service_role;
select a3_overview() is not null as service_role_ok;
reset role;
select 'ALL SQL CHECKS PASSED' as result;
