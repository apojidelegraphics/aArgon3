-- aARgon3 2.5.1: edit codes and deals after they're made, and a version check so the terminal can tell
-- when the database or the server functions are older than the app.
-- Run once in the aARgon3 & Mexel Backend project's SQL Editor, after aargon3-2.5.sql. Safe to run again.

alter table public.promotions add column if not exists edited_at timestamptz;
alter table public.promotions add column if not exists edited_by text;
alter table public.deals add column if not exists edited_at timestamptz;
alter table public.deals add column if not exists edited_by text;

-- which SQL file this database is up to (the terminal warns the owner when it's behind)
create or replace function public.a3_version() returns text language sql immutable as $$ select '2.5.1' $$;

-- promo JSON: plus who edited it last
create or replace function public.a3_promo_json(x public.promotions) returns jsonb language sql stable as $$
  select jsonb_build_object('id', x.id, 'code', x.code, 'type', x.discount_type, 'value', x.discount_value, 'duration', x.duration,
    'duration_months', x.duration_months, 'description', x.description, 'plans', x.applicable_plans, 'tiers', x.applicable_tiers,
    'min_total', x.min_order_total, 'starts', x.start_date, 'ends', x.end_date, 'active', x.is_active, 'limit', x.usage_limit,
    'used', coalesce(x.used_count, 0), 'created_by', x.created_by, 'created_at', x.created_at, 'stripe_promo_id', x.stripe_promo_id,
    'live', x.is_active and (x.end_date is null or x.end_date > now()) and (x.start_date is null or x.start_date <= now())
            and (x.usage_limit is null or coalesce(x.used_count, 0) < x.usage_limit))
  || jsonb_build_object('ended_reason', x.ended_reason, 'ended_at', x.ended_at, 'batch', x.batch, 'old', x.stripe_promo_id is null, 'migrated_at', x.migrated_at,
       'edited_at', x.edited_at, 'edited_by', x.edited_by)
$$;

-- edit a code: only the keys that are present change. The staff function handles Stripe first (a new promotion code,
-- and a new coupon when the discount changes) and passes the new ids here.
create or replace function public.a3_promo_edit(p_id bigint, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x public.promotions; c text := nullif(upper(trim(p->>'code')), '');
begin
  if c is not null then
    if c !~ '^[A-Z0-9_-]{3,30}$' then raise exception 'Codes are 3 to 30 letters, numbers, - or _.'; end if;
    if exists (select 1 from promotions where code = c and id <> p_id) then raise exception 'That code already exists.'; end if;
  end if;
  update promotions set
    code = coalesce(c, code),
    discount_type = coalesce(p->>'type', discount_type), discount_value = coalesce((p->>'value')::numeric, discount_value),
    duration = coalesce(p->>'duration', duration),
    duration_months = case when p ? 'duration_months' then (p->>'duration_months')::int else duration_months end,
    description = coalesce(p->>'description', description),
    applicable_plans = case when p ? 'plans' then (select array_agg(v) from jsonb_array_elements_text(case when jsonb_typeof(p->'plans') = 'array' then p->'plans' else '[]' end) v) else applicable_plans end,
    applicable_tiers = case when p ? 'tiers' then (select array_agg(v) from jsonb_array_elements_text(case when jsonb_typeof(p->'tiers') = 'array' then p->'tiers' else '[]' end) v) else applicable_tiers end,
    min_order_total = coalesce((p->>'min_total')::numeric, min_order_total),
    start_date = case when p ? 'starts' then coalesce((p->>'starts')::timestamptz, start_date) else start_date end,
    end_date = case when p ? 'ends' then (p->>'ends')::timestamptz else end_date end,
    usage_limit = case when p ? 'limit' then (p->>'limit')::int else usage_limit end,
    stripe_coupon_id = coalesce(p->>'stripe_coupon_id', stripe_coupon_id), stripe_promo_id = coalesce(p->>'stripe_promo_id', stripe_promo_id),
    is_active = coalesce((p->>'active')::boolean, is_active),
    ended_reason = case when (p->>'active')::boolean is false then coalesce(p->>'ended_reason', 'manual') when (p->>'active')::boolean then null else ended_reason end,
    ended_at = case when (p->>'active')::boolean is false then coalesce(ended_at, now()) when (p->>'active')::boolean then null else ended_at end,
    edited_at = now(), edited_by = coalesce(p->>'by', edited_by)
  where id = p_id returning * into x;
  if x.id is null then raise exception 'No promotion with that id.'; end if;
  return public.a3_promo_json(x);
end $$;

-- edit a deal: same idea
create or replace function public.a3_deal_edit(p_id bigint, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.deals;
begin
  update deals set
    name = coalesce(p->>'name', name), headline = coalesce(p->>'headline', headline), description = coalesce(p->>'description', description),
    kind = coalesce(p->>'kind', kind),
    value = case when p ? 'value' then (p->>'value')::numeric else value end,
    duration = coalesce(p->>'duration', duration),
    duration_months = case when p ? 'duration_months' then (p->>'duration_months')::int else duration_months end,
    models = case when p ? 'models' then (select array_agg(v) from jsonb_array_elements_text(case when jsonb_typeof(p->'models') = 'array' then p->'models' else '[]' end) v) else models end,
    chip = case when p ? 'chip' then p->>'chip' else chip end,
    plans = case when p ? 'plans' then (select array_agg(v) from jsonb_array_elements_text(case when jsonb_typeof(p->'plans') = 'array' then p->'plans' else '[]' end) v) else plans end,
    tiers = case when p ? 'tiers' then (select array_agg(v) from jsonb_array_elements_text(case when jsonb_typeof(p->'tiers') = 'array' then p->'tiers' else '[]' end) v) else tiers end,
    billing = case when p ? 'billing' then (select array_agg(v) from jsonb_array_elements_text(case when jsonb_typeof(p->'billing') = 'array' then p->'billing' else '[]' end) v) else billing end,
    starts_at = case when p ? 'starts_at' then coalesce((p->>'starts_at')::timestamptz, starts_at) else starts_at end,
    ends_at = case when p ? 'ends_at' then (p->>'ends_at')::timestamptz else ends_at end,
    usage_limit = case when p ? 'limit' then (p->>'limit')::int else usage_limit end,
    featured = coalesce((p->>'featured')::boolean, featured),
    stripe_coupon_id = case when p ? 'stripe_coupon_id' then p->>'stripe_coupon_id' else stripe_coupon_id end,
    active = coalesce((p->>'active')::boolean, active),
    ended_reason = case when (p->>'active')::boolean is false then 'manual' when (p->>'active')::boolean then null else ended_reason end,
    ended_at = case when (p->>'active')::boolean is false then coalesce(ended_at, now()) when (p->>'active')::boolean then null else ended_at end,
    edited_at = now(), edited_by = coalesce(p->>'by', edited_by)
  where id = p_id returning * into d;
  if d.id is null then raise exception 'No deal with that id.'; end if;
  return public.a3_deal_json(d);
end $$;

do $$ declare f text; begin
  foreach f in array array['a3_promo_edit(bigint, jsonb)', 'a3_deal_edit(bigint, jsonb)', 'a3_version()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
