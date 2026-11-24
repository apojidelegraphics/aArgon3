-- aARgon3 2.6: Apoji-wide. A customer can link their Nexus account to an order (picture, frame and name show in
-- Your order and in the terminal), and staff get one search across orders, custom orders, codes, deals and the team.
-- Run once in the aARgon3 & Mexel Backend project's SQL Editor, after aargon3-2.5.1.sql. Safe to run again.
-- (The Nexus side lives in supabase/nexus-side/aargon3-2.6-in-nexus.sql and runs in the NEXUS project.)

create or replace function public.a3_version() returns text language sql immutable as $$ select '2.6.0' $$;

-- the Nexus account a customer linked with a one-time code: { username, nickname, display_name, avatar_url, frame, font, color, ... , linked_at }
alter table public.orders add column if not exists apoji jsonb;

create or replace function public.a3_order_json(o public.orders) returns jsonb language sql stable as $$
  select jsonb_build_object('order_id', o.order_id, 'created_at', o.created_at, 'status', o.status, 'plan', o.plan_type, 'tier', o.tier,
    'billing', o.billing, 'amount', public.a3_amount(o), 'customer_name', o.customer_name, 'customer_email', o.customer_email,
    'operator', o.operator, 'store', o.store_name, 'source', coalesce(o.source, 'legacy'), 'config', o.config,
    'models', (select coalesce(jsonb_agg(i->>'model'), '[]'::jsonb) from jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) i),
    'subscription', o.stripe_subscription_id is not null,
    'company_name', o.company_name, 'customer_phone', o.customer_phone, 'customer_info', o.customer_info, 'seats', o.seats,
    'quote_no', o.quote_no, 'node_id', o.node_id, 'jurisdiction', o.target_jurisdiction, 'promo_code', o.promo_code,
    'discount', o.discount_amount, 'notes', o.notes,
    'paid_total', (select coalesce(sum(amount_cents), 0) / 100.0 from payments y where y.order_id = o.order_id),
    'payments', (select count(*) from payments y where y.order_id = o.order_id))
  || jsonb_build_object('region', o.region, 'tax', o.tax_cents / 100.0, 'current_period_end', o.current_period_end, 'cancel_at', o.cancel_at,
    'paused_until', o.paused_until, 'expires_at', o.expires_at, 'referral_code', o.referral_code, 'referred_by', o.referred_by,
    'gift', o.gift, 'history', o.history, 'stripe_customer', o.stripe_customer_id is not null,
    'referrals', (select count(*) from referrals r where r.referrer_order = o.order_id),
    'referral_credit', (select coalesce(sum(credit_cents), 0) / 100.0 from referrals r where r.referrer_order = o.order_id))
  || jsonb_build_object('deals', o.deals, 'apoji', o.apoji)
$$;

-- link (p = the public profile the checkout function got from Nexus) or unlink (p = null)
create or replace function public.a3_order_apoji(p_order text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.orders; linking boolean := p is not null and jsonb_typeof(p) = 'object';
begin
  update orders set
    apoji = case when linking then p || jsonb_build_object('linked_at', now()) else null end,
    history = coalesce(history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('kind', case when linking then 'apoji_link' else 'apoji_unlink' end,
      'at', now(), 'by', 'customer', 'username', case when linking then p->>'username' else apoji->>'username' end))
  where order_id = p_order returning * into o;
  if o.order_id is null then raise exception 'No order with that number.'; end if;
  return public.a3_order_json(o);
end $$;

-- one search for the terminal (and Apoji Admin's Mexel page). Everyone: orders. Managers: custom orders, codes, deals, team.
create or replace function public.a3_search(p_q text, p_manager boolean default false, p_limit int default 8)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare q text := left(trim(coalesce(p_q, '')), 80); pat text; n int := greatest(1, least(coalesce(p_limit, 8), 25));
begin
  if length(q) < 2 then return '[]'::jsonb; end if;
  pat := '%' || replace(replace(replace(q, '\', ''), '%', ''), '_', '') || '%';
  return coalesce((select jsonb_agg(r) from (
    (select jsonb_build_object('kind', 'order', 'id', o.order_id, 'title', coalesce(nullif(o.company_name, ''), nullif(o.customer_name, ''), o.customer_email, o.order_id),
       'sub', concat_ws(' · ', o.order_id, nullif(concat_ws(' ', o.plan_type, initcap(o.tier)), ''), lower(o.status)), 'at', o.created_at,
       'apoji', o.apoji->>'username', 'avatar', o.apoji->>'avatar_url') r
     from orders o where o.order_id ilike pat or o.customer_name ilike pat or o.customer_email ilike pat or o.company_name ilike pat
       or o.referral_code ilike pat or o.quote_no ilike pat or coalesce(o.apoji->>'username', '') ilike pat
     order by o.created_at desc limit n)
    union all
    (select jsonb_build_object('kind', 'quote', 'id', x.quote_no, 'title', coalesce(nullif(x.customer->>'company', ''), nullif(x.customer->>'name', ''), x.quote_no),
       'sub', concat_ws(' · ', x.quote_no, initcap(x.plan) || ' ' || initcap(x.tier), x.status), 'at', x.created_at)
     from quotes x where p_manager and (x.quote_no ilike pat or x.customer->>'company' ilike pat or x.customer->>'name' ilike pat or x.customer->>'email' ilike pat)
     order by x.created_at desc limit n)
    union all
    (select jsonb_build_object('kind', 'promo', 'id', p.id, 'title', p.code, 'sub', concat_ws(' · ', p.description,
       case when p.is_active and (p.end_date is null or p.end_date > now()) then 'live' else coalesce(p.ended_reason, 'off') end), 'at', p.created_at)
     from promotions p where p_manager and (p.code ilike pat or p.description ilike pat or p.batch ilike pat) order by p.is_active desc, p.created_at desc limit n)
    union all
    (select jsonb_build_object('kind', 'deal', 'id', d.id, 'title', d.headline, 'sub', concat_ws(' · ', nullif(d.name, d.headline), case when d.active then 'on' else 'off' end), 'at', d.created_at)
     from deals d where p_manager and (d.headline ilike pat or d.name ilike pat or coalesce(d.description, '') ilike pat) order by d.active desc, d.created_at desc limit n)
    union all
    (select jsonb_build_object('kind', 'staff', 'id', s.id, 'user_id', s.user_id, 'title', coalesce(nullif(s.display_name, ''), s.name, split_part(s.email, '@', 1)),
       'sub', concat_ws(' · ', s.title, s.role, s.email), 'at', s.created_at)
     from staff s where p_manager and (s.name ilike pat or s.display_name ilike pat or s.email ilike pat or s.title ilike pat) order by s.active desc, s.name limit n)
  ) z), '[]'::jsonb);
end $$;

do $$ declare f text; begin
  foreach f in array array['a3_order_apoji(text, jsonb)', 'a3_search(text, boolean, int)', 'a3_version()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
revoke select (apoji) on public.orders from anon;
