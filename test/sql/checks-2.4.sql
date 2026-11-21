-- aARgon3 2.4 checks: portal, gifts, referrals, plan changes and pausing, abandoned checkouts, hours and closures. Runs after checks-2.3.sql.
\set ON_ERROR_STOP 1
do $$
declare o jsonb; n int; s jsonb;
begin
  -- an order from the store, then the 2.4 extras
  perform a3_record_order('{"order_id":"PORTAL00-0001","stripe_session_id":"cs_portal","stripe_subscription_id":"sub_portal","stripe_customer_id":"cus_portal","plan_type":"Business","tier":"pro","billing":"month","amount_cents":15900,"customer_email":"Kim@Co.com","customer_name":"Kim Park"}');
  o := a3_order_patch('PORTAL00-0001', '{"region":"B","tax_cents":1000,"referral_code":"REF-KIM777","current_period_end":"2026-12-21T00:00:00Z"}');
  assert o->>'region' = 'B' and (o->>'tax')::numeric = 10 and o->>'referral_code' = 'REF-KIM777', 'patched';
  o := a3_order_patch('PORTAL00-0001', '{"referral_code":"REF-OTHER1"}');
  assert o->>'referral_code' = 'REF-KIM777', 'a referral code never changes once set';
  -- portal: number + email (any case), not someone else's email
  assert a3_portal_order('portal00-0001', ' kim@co.com ')->>'order_id' = 'PORTAL00-0001', 'portal lookup';
  assert a3_portal_order('PORTAL00-0001', 'nope@co.com') is null, 'wrong email';
  assert a3_portal_attempt(array['ip:1.1.1.1', 'order:X'], true) = 1, 'one failure';
  perform a3_portal_attempt(array['ip:1.1.1.1'], true);
  assert a3_portal_attempt(array['ip:1.1.1.1', 'order:Y'], false) = 2, 'counted per key, worst wins';
  -- plan change + pause, with history
  o := a3_order_patch('PORTAL00-0001', '{"tier":"max","plan_type":"Business","amount_cents":29900,"items":[{"model":"Neodela"}],"event":{"kind":"change","from":"pro","to":"max"}}');
  assert o->>'tier' = 'max' and jsonb_array_length(o->'history') = 1 and (o->'history'->0) ? 'at', 'change logged';
  assert a3_subscription_sync('sub_portal', '{"status":"PAUSED","paused_until":"2027-01-21T00:00:00Z"}') = 1, 'sync pause';
  assert (select status from orders where order_id = 'PORTAL00-0001') = 'PAUSED', 'paused';
  perform a3_subscription_sync('sub_portal', '{"status":"ACTIVE","paused_until":null,"cancel_at":"2026-12-21T00:00:00Z"}');
  assert (select paused_until is null and cancel_at is not null from orders where order_id = 'PORTAL00-0001'), 'resumed, cancelling at period end';
  assert (select count(*) from payments where order_id = 'PORTAL00-0001') = 1, 'first payment recorded';
  perform a3_record_payment('in_change1', 'sub_portal', 4000, 'change');
  assert (select count(*) from payments where kind = 'change') = 1, 'change payments allowed';
  -- referrals: code finds the referrer; one reward per new order; counted for the yearly limit
  s := a3_referrer('ref-kim777'); assert s->>'order_id' = 'PORTAL00-0001' and s->>'email' = 'kim@co.com' and (s->>'this_year')::int = 0, 'referrer';
  assert (a3_referral_record('{"code":"REF-KIM777","referrer_order":"PORTAL00-0001","new_order":"NEWBIE00-0001","credit_cents":15900,"stripe_txn_id":"cbtxn_1"}')->>'recorded')::boolean, 'recorded';
  assert not (a3_referral_record('{"code":"REF-KIM777","referrer_order":"PORTAL00-0001","new_order":"NEWBIE00-0001","credit_cents":15900}')->>'recorded')::boolean, 'once per new order';
  assert (a3_referrer('REF-KIM777')->>'this_year')::int = 1, 'counted';
  assert (a3_order('PORTAL00-0001')->>'referrals')::int = 1 and (a3_order('PORTAL00-0001')->>'referral_credit')::numeric = 159, 'shown on the order';
  -- gifts: hidden from the portal until claimed; claim once; months start at claim
  perform a3_record_order('{"order_id":"GIFT0000-0001","stripe_session_id":"cs_gift","plan_type":"Personal","tier":"plus","billing":"once","amount_cents":3600,"customer_email":"giver@x.co"}');
  perform a3_order_patch('GIFT0000-0001', '{"status":"GIFT","gift_code":"GIFT-ABCD-EFGH","gift":{"months":3,"to_name":"Ari","to_email":"ari@x.co","from_name":"Jo"}}');
  assert a3_portal_order('GIFT0000-0001', 'giver@x.co') is null, 'unclaimed gifts are not in the portal';
  assert (a3_gift('gift-abcd-efgh')->>'months')::int = 3 and not (a3_gift('GIFT-ABCD-EFGH')->>'claimed')::boolean, 'gift preview';
  o := a3_gift_claim('GIFT-ABCD-EFGH', '{"first":"Ari","last":"Lane","email":"ARI@x.co"}');
  assert o->>'status' = 'ACTIVE' and o->>'customer_email' = 'ari@x.co' and (o->>'expires_at')::timestamptz > now() + interval '85 days', 'claimed';
  begin perform a3_gift_claim('GIFT-ABCD-EFGH', '{"email":"z@z.co"}'); assert false, 'claim twice'; exception when raise_exception then null; end;
  begin perform a3_gift_claim('GIFT-NOPE-NOPE', '{"email":"z@z.co"}'); assert false, 'bad code'; exception when raise_exception then null; end;
  assert a3_portal_order('GIFT0000-0001', 'ari@x.co')->>'order_id' = 'GIFT0000-0001', 'claimed gift is in the portal';
  update orders set expires_at = now() - interval '1 minute' where order_id = 'GIFT0000-0001';
  n := a3_expire(); assert n = 1, 'one expired: ' || n;
  assert (select status from orders where order_id = 'GIFT0000-0001') = 'EXPIRED', 'expired';
  -- abandoned: saved once; skipped if they already bought
  assert (a3_abandoned_save('{"session_id":"cs_ab1","email":"Lee@x.co","label":"Personal Pro · monthly","amount_cents":2500,"link":"https://x/?p"}')->>'saved')::boolean, 'abandoned saved';
  assert not (a3_abandoned_save('{"session_id":"cs_ab1","email":"lee@x.co"}')->>'saved')::boolean, 'once';
  assert not (a3_abandoned_save('{"session_id":"cs_ab2","email":"kim@co.com"}')->>'saved')::boolean, 'already bought';
  perform a3_abandoned_mark('cs_ab1', null);
  assert (a3_abandoned(10)->0->>'emailed_at') is not null, 'marked emailed';
  -- hours and closures
  s := a3_store_hours('0028', '{"mon":["09:00","21:00"],"sun":null}');
  assert (select hours->'mon'->>0 from stores where code = '0028') = '09:00', 'hours saved';
  s := a3_closure_save('{"store_code":"","starts_on":"2026-11-26","ends_on":"2026-11-27","reason":"Thanksgiving","by":"Lucas"}');
  s := a3_closure_save('{"store_code":"0028","starts_on":"2026-12-25","ends_on":"2026-12-25","reason":"Christmas"}');
  assert jsonb_array_length(s->'closures') >= 1, 'closures listed';
  assert (select count(*) from closures where store_code is null) = 1, 'online closure';
  begin perform a3_closure_save('{"store_code":"9999","starts_on":"2026-12-01","ends_on":"2026-12-01"}'); assert false, 'unknown store'; exception when raise_exception then null; end;
  begin perform a3_closure_save('{"starts_on":"2026-12-05","ends_on":"2026-12-01"}'); assert false, 'backwards'; exception when raise_exception then null; end;
  perform a3_closure_delete((select id from closures where reason = 'Christmas'));
  assert (select count(*) from closures where reason = 'Christmas') = 0, 'deleted';
  -- new settings keys
  perform a3_setting_set('tax', '{"enabled":true,"label":"Sales tax","regions":{"B":{"rate":7.5}}}', 'Lucas');
  assert (a3_settings()->'tax'->'regions'->'B'->>'rate')::numeric = 7.5, 'tax setting';
  begin perform a3_setting_set('nope', '{}', 'x'); assert false, 'unknown key'; exception when raise_exception then null; end;
end $$;

set role anon;
do $$ begin
  begin perform * from referrals; assert false, 'anon referrals'; exception when insufficient_privilege then null; end;
  begin perform * from abandoned; assert false, 'anon abandoned'; exception when insufficient_privilege then null; end;
  begin perform * from closures; assert false, 'anon closures'; exception when insufficient_privilege then null; end;
  begin perform a3_portal_order('X', 'y'); assert false, 'anon portal'; exception when insufficient_privilege then null; end;
  begin perform a3_gift_claim('X', '{}'); assert false, 'anon claim'; exception when insufficient_privilege then null; end;
  begin perform region from orders; assert false, 'anon new order columns'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'ALL 2.4 CHECKS PASSED' as result;
