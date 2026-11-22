-- aARgon3 2.5 checks: deals, codes that switch off by themselves, old-code upgrades, portal contact edits. Runs after checks-2.4.sql.
\set ON_ERROR_STOP 1
do $$
declare d jsonb; x jsonb; n int;
begin
  -- deals
  d := a3_deal_save('{"name":"BF bundle","headline":"Get Neodela free with Plus","kind":"models","models":["Neodela"],"tiers":["plus"],"ends_at":"2099-01-01T00:00:00Z","by":"Lucas"}');
  assert (d->>'live')::boolean and d->>'kind' = 'models' and not (d ? 'stripe_coupon_id'), 'deal saved, coupon id hidden';
  perform a3_deal_save('{"name":"Old","headline":"Gone","kind":"percent","value":20,"ends_at":"2000-01-01T00:00:00Z","stripe_coupon_id":"co_x"}');
  assert jsonb_array_length(a3_deals_live()) = 1, 'only live deals for checkout';
  assert a3_deals_live()->0->>'headline' = 'Get Neodela free with Plus', 'live deal';
  perform a3_deals_used(array[(d->>'id')::bigint]);
  assert (select used_count from deals where id = (d->>'id')::bigint) = 1, 'deal use counted';
  x := a3_deal_save(jsonb_build_object('id', d->>'id', 'active', false));
  assert x->>'ended_reason' = 'manual' and not (x->>'live')::boolean, 'switched off by hand';
  x := a3_deal_save(jsonb_build_object('id', d->>'id', 'active', true));
  assert x->>'ended_reason' is null and (x->>'live')::boolean, 'back on';
  -- the hourly job: expired and used-up codes and deals switch off, with the reason
  insert into promotions (code, discount_type, discount_value, is_active, end_date, start_date) values ('OLDNOV', 'percentage', 10, true, now() - interval '1 hour', now() - interval '9 days');
  insert into promotions (code, discount_type, discount_value, is_active, usage_limit, used_count, start_date) values ('USEDUP', 'fixed', 5, true, 2, 2, now() - interval '1 day');
  insert into promotions (code, discount_type, discount_value, is_active, end_date, start_date) values ('STILLOK', 'fixed', 5, true, now() + interval '9 days', now() - interval '1 day');
  n := a3_expire();
  assert n >= 3, 'expired things: ' || n;
  assert (select is_active from promotions where code = 'STILLOK'), 'live code untouched';
  assert (select ended_reason from promotions where code = 'OLDNOV') = 'expired', 'expired code';
  assert (select ended_reason from promotions where code = 'USEDUP') = 'used up', 'used-up code';
  assert (select not active and ended_reason = 'expired' from deals where name = 'Old'), 'expired deal';
  assert (a3_promo('OLDNOV')->>'ended_reason') = 'expired' and (a3_promo('OLDNOV')->>'old')::boolean, 'promo json shows why, and that it is an old code';
  -- upgrade an old code
  insert into promotions (code, discount_type, discount_value, is_active, applicable_plans, start_date) values ('fall fun', 'percentage', 15, true, array['Personal'], now());
  x := a3_promo_upgrade((select id from promotions where code = 'fall fun'), '{"code":"FALL-FUN","plans":["personal"],"stripe_coupon_id":"co_1","stripe_promo_id":"promo_1","description":"15% off the first payment"}');
  assert x->>'code' = 'FALL-FUN' and not (x->>'old')::boolean and x->'plans'->>0 = 'personal' and x->>'migrated_at' is not null, 'upgraded';
  -- generated batches
  x := a3_promo_save('{"code":"WINTER26-AB12","type":"percentage","value":20,"batch":"WINTER26","stripe_promo_id":"promo_w"}');
  assert x->>'batch' = 'WINTER26', 'batch kept';
  -- portal contact edits (email stays put)
  perform a3_record_order('{"order_id":"CONTACT0-0001","stripe_session_id":"cs_contact","plan_type":"Business","tier":"pro","billing":"month","amount_cents":15900,"customer_email":"c@x.co","customer_name":"Old Name"}');
  x := a3_order_contact('CONTACT0-0001', '{"first":"New","last":"Name","phone":"555","company":"NewCo","email":"hacker@x.co"}');
  assert x->>'customer_name' = 'New Name' and x->>'company_name' = 'NewCo' and x->>'customer_email' = 'c@x.co', 'contact updated, email unchanged';
  perform a3_order_patch_deals('CONTACT0-0001', '[{"id":1,"headline":"Get Neodela free with Plus","kind":"models"}]');
  assert a3_order('CONTACT0-0001')->'deals'->0->>'kind' = 'models', 'deals on the order';
end $$;
set role anon;
do $$ begin
  begin perform * from deals; assert false, 'anon deals'; exception when insufficient_privilege then null; end;
  begin perform a3_deals_live(); assert false, 'anon live deals'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'ALL 2.5 CHECKS PASSED' as result;
