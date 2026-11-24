-- aARgon3 2.6: Apoji account on orders, one search. Runs after checks-2.5.1.sql.
\set ON_ERROR_STOP 1
do $$
declare x jsonb; r jsonb;
begin
  assert a3_version() = '2.6.0', 'version';
  perform a3_record_order('{"order_id":"APOJI000-0001","stripe_session_id":"cs_apoji","plan_type":"Business","tier":"pro","billing":"month","amount_cents":14900,"customer_email":"kim@northwind.co","customer_name":"Kim Park","company_name":"Northwind Studio"}');
  x := a3_order_apoji('APOJI000-0001', '{"username":"kimp","nickname":"Kim","avatar_url":"https://x.supabase.co/storage/v1/object/public/avatars/u/avatar.webp","frame":"frame:neon"}');
  assert x->'apoji'->>'username' = 'kimp' and x->'apoji'->>'linked_at' is not null, 'linked';
  assert x->'history'->-1->>'kind' = 'apoji_link' and x->'history'->-1->>'username' = 'kimp', 'history link';
  x := a3_order_apoji('APOJI000-0001', null);
  assert x->'apoji' = 'null'::jsonb and x->'history'->-1->>'kind' = 'apoji_unlink' and x->'history'->-1->>'username' = 'kimp', 'unlinked';
  perform a3_order_apoji('APOJI000-0001', '{"username":"kimp"}');
  begin perform a3_order_apoji('NOPE0000-0000', '{"username":"x"}'); assert false, 'missing order'; exception when raise_exception then null; end;

  r := a3_search('kimp');
  assert jsonb_array_length(r) >= 1 and r->0->>'kind' = 'order' and r->0->>'id' = 'APOJI000-0001' and r->0->>'apoji' = 'kimp', 'order by Nexus username';
  r := a3_search('northwind', false);
  assert (select count(*) from jsonb_array_elements(r) e where e->>'kind' <> 'order') = 0, 'employees only see orders';
  r := a3_search('apoji000');
  assert r->0->>'sub' like 'APOJI000-0001 · Business Pro%', 'sub line';
  assert a3_search('k') = '[]'::jsonb, 'too short';
  assert a3_search('%') = '[]'::jsonb, 'wildcards stripped';
  perform a3_promo_save('{"code":"NORTHWIND10","type":"percentage","value":10}');
  r := a3_search('northwind', true);
  assert (select count(*) from jsonb_array_elements(r) e where e->>'kind' = 'promo') = 1, 'managers see codes';
end $$;
set role anon;
do $$ begin
  begin perform a3_search('kim', true); assert false, 'anon search'; exception when insufficient_privilege then null; end;
  begin perform a3_order_apoji('APOJI000-0001', null); assert false, 'anon link'; exception when insufficient_privilege then null; end;
  begin perform apoji from orders; assert false, 'anon apoji column'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'ALL 2.6 CHECKS PASSED' as result;
