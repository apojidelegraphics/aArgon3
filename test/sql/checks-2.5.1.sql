-- aARgon3 2.5.1: editing codes and deals, version check. Runs after checks-2.5.sql.
\set ON_ERROR_STOP 1
do $$
declare x jsonb; d jsonb; pid bigint; did bigint;
begin
  assert a3_version() = '2.5.1', 'version';
  x := a3_promo_save('{"code":"EDITME","type":"percentage","value":10,"duration":"once","plans":["personal"],"stripe_coupon_id":"co_1","stripe_promo_id":"promo_1","created_by":"Lucas"}');
  pid := (x->>'id')::bigint;
  x := a3_promo_edit(pid, '{"code":"edited","value":25,"duration":"repeating","duration_months":3,"plans":[],"tiers":["pro","max"],"limit":50,"ends":"2099-01-01T00:00:00Z","stripe_promo_id":"promo_2","by":"Riley"}');
  assert x->>'code' = 'EDITED' and (x->>'value')::numeric = 25 and x->>'duration' = 'repeating' and (x->>'duration_months')::int = 3, 'discount edited';
  assert x->'plans' = 'null'::jsonb and x->'tiers' = '["pro","max"]'::jsonb and (x->>'limit')::int = 50, 'scope edited';
  assert x->>'stripe_promo_id' = 'promo_2' and x->>'edited_by' = 'Riley' and x->>'edited_at' is not null and (x->>'live')::boolean, 'stripe ids and who';
  assert (select stripe_coupon_id from promotions where id = pid) = 'co_1', 'coupon kept when not passed';
  x := a3_promo_edit(pid, '{"limit":null,"ends":null}');
  assert x->'limit' = 'null'::jsonb and x->'ends' = 'null'::jsonb, 'cleared limit and end';
  x := a3_promo_edit(pid, '{"active":false}');
  assert not (x->>'active')::boolean and x->>'ended_reason' = 'manual', 'off by hand';
  x := a3_promo_edit(pid, '{"active":true}');
  assert (x->>'active')::boolean and x->>'ended_reason' is null and x->>'ended_at' is null, 'back on';
  perform a3_promo_save('{"code":"TAKEN","type":"percentage","value":5}');
  begin perform a3_promo_edit(pid, '{"code":"TAKEN"}'); assert false, 'duplicate code'; exception when raise_exception then null; end;
  begin perform a3_promo_edit(999999, '{"value":5}'); assert false, 'missing promo'; exception when raise_exception then null; end;

  d := a3_deal_save('{"name":"Plus bundle","headline":"Neodela free with Plus","kind":"models","models":["Neodela"],"tiers":["plus"]}');
  did := (d->>'id')::bigint;
  d := a3_deal_edit(did, '{"kind":"percent","value":20,"duration":"repeating","duration_months":3,"models":null,"headline":"20% off Plus","stripe_coupon_id":"co_deal","tiers":["plus","pro"],"billing":["year"],"limit":10,"featured":false,"by":"Lucas"}');
  assert d->>'kind' = 'percent' and (d->>'value')::numeric = 20 and d->'models' = 'null'::jsonb and d->>'headline' = '20% off Plus', 'deal edited';
  assert d->'tiers' = '["plus","pro"]'::jsonb and d->'billing' = '["year"]'::jsonb and (d->>'usage_limit')::int = 10 and not (d->>'featured')::boolean, 'deal scope';
  assert (d->>'has_coupon')::boolean and d->>'edited_by' = 'Lucas', 'coupon + who';
  assert (select stripe_coupon_id from deals where id = did) = 'co_deal', 'coupon saved';
  d := a3_deal_edit(did, '{"kind":"seats","value":2,"stripe_coupon_id":null}');
  assert not (d->>'has_coupon')::boolean and d->>'kind' = 'seats', 'coupon removed for a perk';
  d := a3_deal_edit(did, '{"active":false}');
  assert d->>'ended_reason' = 'manual', 'deal off';
  d := a3_deal_edit(did, '{"active":true,"ends_at":"2099-01-01T00:00:00Z"}');
  assert (d->>'active')::boolean and d->>'ended_reason' is null and (d->>'live')::boolean, 'deal back on';
  begin perform a3_deal_edit(999999, '{"active":true}'); assert false, 'missing deal'; exception when raise_exception then null; end;
end $$;
set role anon;
do $$ begin
  begin perform a3_promo_edit(1, '{}'); assert false, 'anon edit'; exception when insufficient_privilege then null; end;
  begin perform a3_deal_edit(1, '{}'); assert false, 'anon deal edit'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'ALL 2.5.1 CHECKS PASSED' as result;
