-- aARgon3 2.0 — run once in the aARgon3 & Mexel Backend project (yuergfrpfhtcxjkcgjrx): SQL Editor → paste → Run.
-- Safe to run again.
--
-- What it does
--   1. Locks the tables down. Before this, row-level security was off, so anyone with the public key could read
--      customers' names and emails, or create an ACTIVE order and redeem it in Nexus for free.
--      After it: nobody can write orders or shifts from a browser. Orders are written only by the Stripe webhook and
--      the staff function (with the service key). Nexus '28 can still look up an order's number, plan, status, system
--      and models (the five columns it reads), never customer details.
--   2. Orders get Stripe columns (session, subscription, customer, billing, tier, source, amount in cents).
--   3. Stores move into a table (the 33 stores from the old terminal).
--   4. The new clock in / clock out: shifts belong to a staff account (not a typed name), one open shift per person,
--      breaks, a note, "I forgot to clock out" with the real time, and manager fixes that are logged.
--   5. Server-only functions (a3_*) the Edge Functions call. Browsers can't call them.
--
-- Note: the old aARgon3 page and the old Mexel dashboard read and write these tables directly, so they stop working
-- after this. That's on purpose: the new terminal replaces aARgon3, and Mexel moves into Apoji Admin.

-- ============================================================ 1. orders: new columns
alter table public.orders add column if not exists stripe_session_id text;
alter table public.orders add column if not exists stripe_subscription_id text;
alter table public.orders add column if not exists stripe_customer_id text;
alter table public.orders add column if not exists billing text;
alter table public.orders add column if not exists tier text;
alter table public.orders add column if not exists source text;          -- 'web' (store), 'terminal' (staff sale), 'comp' (free, by a manager)
alter table public.orders add column if not exists staff_user_id uuid;   -- the Nexus account of the staff member who made the sale
alter table public.orders add column if not exists amount_cents integer;
create unique index if not exists orders_order_id_key on public.orders (order_id);
create unique index if not exists orders_stripe_session_key on public.orders (stripe_session_id) where stripe_session_id is not null;
create index if not exists orders_subscription_idx on public.orders (stripe_subscription_id) where stripe_subscription_id is not null;
create index if not exists orders_created_idx on public.orders (created_at desc);

-- ============================================================ 2. stores
create table if not exists public.stores (
  code text primary key,
  name text not null,
  region text not null default 'A',
  active boolean not null default true
);
insert into public.stores (code, name, region) values
  ('0028','Neo Silicon Valley Flagship (Hub Zero)','A'),('2882','San Jose Quantum Cluster','A'),('0095','Palo Alto Metro Station','A'),
  ('0027','Cupertino Legacy Bay','A'),('2710','San Francisco Soar Node','A'),('2720','Oakland Denali Ridge','A'),
  ('2630','Seattle Finale Nexus','A'),('7635','Portland Testimony Annex','A'),('3279','San Diego Cascade','A'),
  ('0190','Phoenix Dahrk Zone','A'),('0427','Raleigh-Durham Omni-Node','B'),('0227','Charlotte Sonoma Cluster','B'),
  ('0327','New York Wall Street Terminal','B'),('0120','Boston Quouk Laboratory','B'),('0220','Cambridge Hybrid Core','B'),
  ('0320','Atlanta Omni-Lane','B'),('0780','Miami Myst Edge','B'),('0920','Washington D.C. Hailos Gateway','B'),
  ('0921','Baltimore Sovereign Node','B'),('3993','Austin SwiftStream Grid','C'),('0200','Dallas Flash Station','C'),
  ('0026','Houston Lyte Cluster','C'),('2701','Chicago Monolog Override','C'),('2702','Denver Denali Peak','C'),
  ('2703','Salt Lake Armerad Vault','C'),('0600','Minneapolis High-Efficiency Hub','C'),('0300','Detroit Quantum Edge','C'),
  ('4500','Toronto Shield Link','D'),('1016','London OmniBrief Array','D'),('2039','Tokyo Infinite Loop (Redacted Branch)','D'),
  ('1926','Sydney Horizon Outpost','D'),('0001','Apoji Corporate Office NC','E'),('0002','Apoji Corporate Office CA','E')
on conflict (code) do nothing;

-- ============================================================ 3. shifts: the new clock
alter table public.shifts add column if not exists user_id uuid;            -- Nexus account id
alter table public.shifts add column if not exists store_code text;
alter table public.shifts add column if not exists breaks jsonb not null default '[]'::jsonb;   -- [{ "start": ts, "end": ts|null }]
alter table public.shifts add column if not exists note text;
alter table public.shifts add column if not exists edited_by text;
alter table public.shifts add column if not exists edited_at timestamptz;
alter table public.shifts add column if not exists forgot boolean not null default false;      -- clock-out time was entered afterwards
-- old shifts without an account can't be "open" any more
update public.shifts set clock_out = coalesce(clock_out, clock_in), status = 'closed' where user_id is null and clock_out is null;
create unique index if not exists shifts_one_open_per_person on public.shifts (user_id) where clock_out is null;
create index if not exists shifts_user_idx on public.shifts (user_id, clock_in desc);

-- who did what in the terminal (sales links, comps, cancels, shift fixes)
create table if not exists public.staff_log (
  id bigint generated by default as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  name text,
  action text not null,
  details jsonb not null default '{}'::jsonb
);

-- ============================================================ 4. lock it down
alter table public.orders enable row level security;
alter table public.shifts enable row level security;
alter table public.promotions enable row level security;
alter table public.terms enable row level security;
alter table public.stores enable row level security;
alter table public.staff_log enable row level security;

revoke all on public.orders, public.shifts, public.promotions, public.stores, public.staff_log from anon, authenticated;
revoke insert, update, delete, truncate on public.terms from anon, authenticated;

-- Nexus '28 redeems orders by number with the public key. It may read these five columns and nothing else.
grant select (order_id, plan_type, status, config, items) on public.orders to anon, authenticated;
drop policy if exists "nexus can look up orders" on public.orders;
create policy "nexus can look up orders" on public.orders for select to anon, authenticated using (true);
-- the product terms stay public
grant select on public.terms to anon, authenticated;
drop policy if exists "terms are public" on public.terms;
create policy "terms are public" on public.terms for select to anon, authenticated using (true);

-- ============================================================ 5. helpers
create or replace function public.a3_amount(o public.orders) returns numeric language sql immutable as $$
  select coalesce(o.amount_cents / 100.0, case when o.total_price ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then o.total_price::numeric else 0 end)
$$;

-- minutes worked in a shift: clock in → clock out (or now), minus breaks
create or replace function public.a3_minutes(s public.shifts) returns integer language sql stable as $$
  select greatest(0, floor(extract(epoch from (coalesce(s.clock_out, now()) - s.clock_in)) / 60
    - coalesce((select sum(extract(epoch from (coalesce((b->>'end')::timestamptz, s.clock_out, now()) - (b->>'start')::timestamptz)) / 60)
                from jsonb_array_elements(s.breaks) b), 0)))::int
$$;

create or replace function public.a3_shift_json(s public.shifts) returns jsonb language sql stable as $$
  select jsonb_build_object('id', s.id, 'user_id', s.user_id, 'name', s.employee_name, 'store_code', s.store_code, 'store', s.store_name,
    'clock_in', s.clock_in, 'clock_out', s.clock_out, 'breaks', s.breaks, 'note', s.note, 'forgot', s.forgot,
    'edited_by', s.edited_by, 'edited_at', s.edited_at, 'minutes', public.a3_minutes(s),
    'on_break', exists (select 1 from jsonb_array_elements(s.breaks) b where b->>'end' is null) and s.clock_out is null,
    'sales', coalesce(s.total_sales, 0), 'orders', coalesce(s.total_orders, 0))
$$;

create or replace function public.a3_order_json(o public.orders) returns jsonb language sql stable as $$
  select jsonb_build_object('order_id', o.order_id, 'created_at', o.created_at, 'status', o.status, 'plan', o.plan_type, 'tier', o.tier,
    'billing', o.billing, 'amount', public.a3_amount(o), 'customer_name', o.customer_name, 'customer_email', o.customer_email,
    'operator', o.operator, 'store', o.store_name, 'source', coalesce(o.source, 'legacy'), 'config', o.config,
    'models', (select coalesce(jsonb_agg(i->>'model'), '[]'::jsonb) from jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) i),
    'subscription', o.stripe_subscription_id is not null)
$$;

-- ============================================================ 6. orders (called by the Stripe webhook and the staff function)
-- p: { order_id, stripe_session_id, stripe_subscription_id, stripe_customer_id, plan_type, tier, billing, config, items,
--      amount_cents, currency, customer_name, customer_email, source, staff_user_id, operator, shift_id, payment_method, notes }
create or replace function public.a3_record_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare existing text; s public.shifts; oid text := p->>'order_id';
begin
  if p->>'stripe_session_id' is not null then
    select order_id into existing from orders where stripe_session_id = p->>'stripe_session_id';
    if existing is not null then return jsonb_build_object('order_id', existing, 'created', false); end if;
  end if;
  if (p->>'shift_id') is not null then select * into s from shifts where id = (p->>'shift_id')::bigint; end if;
  insert into orders (order_id, status, plan_type, tier, billing, config, items, amount_cents, total_price, currency, customer_name, customer_email,
                      source, staff_user_id, operator, store_name, shift_id, payment_method, notes,
                      stripe_session_id, stripe_subscription_id, stripe_customer_id)
  values (oid, 'ACTIVE', p->>'plan_type', p->>'tier', p->>'billing', (p->'config')::json, p->'items', (p->>'amount_cents')::int,
          to_char(coalesce((p->>'amount_cents')::numeric, 0) / 100, 'FM999999990.00'), upper(coalesce(p->>'currency', 'usd')),
          nullif(p->>'customer_name', ''), nullif(p->>'customer_email', ''), coalesce(p->>'source', 'web'), (p->>'staff_user_id')::uuid,
          coalesce(p->>'operator', 'Online store'), coalesce(s.store_name, case when p->>'source' = 'web' then 'Online store' end), s.id,
          coalesce(p->>'payment_method', 'card'), p->>'notes',
          p->>'stripe_session_id', p->>'stripe_subscription_id', p->>'stripe_customer_id');
  if s.id is not null then
    update shifts set total_sales = coalesce(total_sales, 0) + coalesce((p->>'amount_cents')::numeric, 0) / 100,
                      total_orders = coalesce(total_orders, 0) + 1 where id = s.id;
  end if;
  return jsonb_build_object('order_id', oid, 'created', true);
end $$;

-- status by order number or by Stripe subscription (CANCELLED / REFUNDED make Nexus refuse the order)
create or replace function public.a3_set_status(p_order text, p_subscription text, p_status text) returns integer
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update orders set status = upper(p_status)
   where (p_order is not null and order_id = p_order) or (p_subscription is not null and stripe_subscription_id = p_subscription);
  get diagnostics n = row_count; return n;
end $$;

-- the thank-you page polls this until the webhook has written the order
create or replace function public.a3_order_by_session(p_session text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('order_id', order_id, 'plan', plan_type, 'tier', tier, 'status', status, 'config', config,
                            'email', customer_email, 'billing', billing)
    from orders where stripe_session_id = p_session
$$;

create or replace function public.a3_order(p_order text) returns jsonb
language sql stable security definer set search_path = public as $$
  select public.a3_order_json(o) || jsonb_build_object('stripe_subscription_id', o.stripe_subscription_id) from orders o where o.order_id = upper(trim(p_order))
$$;

-- newest first; searches order number, customer email and name
create or replace function public.a3_orders(p_q text default '', p_limit int default 50) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.a3_order_json(o) order by o.created_at desc), '[]'::jsonb) from (
    select * from orders o
     where coalesce(trim(p_q), '') = '' or o.order_id ilike '%' || trim(p_q) || '%' or o.customer_email ilike '%' || trim(p_q) || '%'
        or o.customer_name ilike '%' || trim(p_q) || '%'
     order by o.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) o
$$;

-- ============================================================ 7. the clock
-- everything the terminal needs when it opens (or refreshes) for one person
create or replace function public.a3_staff_state(p_user uuid, p_tz text default 'America/New_York') returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'shift', (select public.a3_shift_json(s) from shifts s where s.user_id = p_user and s.clock_out is null),
    'last_store', (select s.store_code from shifts s where s.user_id = p_user and s.store_code is not null order by s.clock_in desc limit 1),
    'week_minutes', (select coalesce(sum(public.a3_minutes(s)), 0) from shifts s where s.user_id = p_user
                       and s.clock_in >= (date_trunc('week', now() at time zone p_tz) at time zone p_tz)),
    'stores', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'region', region) order by region, name), '[]'::jsonb)
                 from stores where active))
$$;

create or replace function public.a3_clock_in(p_user uuid, p_name text, p_store text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare st public.stores; s public.shifts;
begin
  if exists (select 1 from shifts where user_id = p_user and clock_out is null) then raise exception 'You''re already clocked in.'; end if;
  select * into st from stores where code = p_store and active;
  if st.code is null then raise exception 'Pick a store.'; end if;
  insert into shifts (user_id, employee_name, store_code, store_name, clock_in, status)
  values (p_user, coalesce(nullif(trim(p_name), ''), 'Staff'), st.code, 'Store #' || st.code || ' – ' || st.name, now(), 'active')
  returning * into s;
  return public.a3_shift_json(s);
end $$;

-- p_at: when you actually left, if you forgot to clock out (must be after you clocked in and not in the future)
create or replace function public.a3_clock_out(p_user uuid, p_note text default null, p_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.shifts; t timestamptz := coalesce(p_at, now());
begin
  select * into s from shifts where user_id = p_user and clock_out is null for update;
  if s.id is null then raise exception 'You''re not clocked in.'; end if;
  if t <= s.clock_in or t > now() + interval '1 minute' then raise exception 'That clock-out time is outside your shift.'; end if;
  update shifts set clock_out = t, status = 'closed', forgot = p_at is not null,
         note = coalesce(nullif(trim(p_note), ''), note),
         breaks = (select coalesce(jsonb_agg(case when b->>'end' is null then b || jsonb_build_object('end', t) else b end), '[]'::jsonb)
                     from jsonb_array_elements(breaks) b)
   where id = s.id returning * into s;
  return public.a3_shift_json(s);
end $$;

create or replace function public.a3_break(p_user uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.shifts; open_break boolean;
begin
  select * into s from shifts where user_id = p_user and clock_out is null for update;
  if s.id is null then raise exception 'Clock in first.'; end if;
  open_break := exists (select 1 from jsonb_array_elements(s.breaks) b where b->>'end' is null);
  if p_on and open_break then raise exception 'You''re already on a break.'; end if;
  if not p_on and not open_break then raise exception 'You''re not on a break.'; end if;
  update shifts set breaks = case when p_on then breaks || jsonb_build_array(jsonb_build_object('start', now(), 'end', null))
         else (select jsonb_agg(case when b->>'end' is null then b || jsonb_build_object('end', now()) else b end) from jsonb_array_elements(breaks) b) end
   where id = s.id returning * into s;
  return public.a3_shift_json(s);
end $$;

-- timesheets: one person (p_user) or everyone (null; managers only, checked by the staff function)
create or replace function public.a3_shifts(p_user uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.a3_shift_json(s) order by s.clock_in desc), '[]'::jsonb)
    from shifts s where (p_user is null or s.user_id = p_user) and s.clock_in >= p_from and s.clock_in < p_to and s.user_id is not null
$$;

-- a manager fixes a shift's times or note (logged with who did it)
create or replace function public.a3_edit_shift(p_id bigint, p_clock_in timestamptz, p_clock_out timestamptz, p_note text, p_by text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.shifts;
begin
  if p_clock_out is not null and p_clock_out <= p_clock_in then raise exception 'Clock-out has to be after clock-in.'; end if;
  update shifts set clock_in = p_clock_in, clock_out = p_clock_out, status = case when p_clock_out is null then 'active' else 'closed' end,
         note = p_note, edited_by = p_by, edited_at = now(),
         breaks = case when p_clock_out is null then breaks else
           (select coalesce(jsonb_agg(case when b->>'end' is null then b || jsonb_build_object('end', p_clock_out) else b end), '[]'::jsonb) from jsonb_array_elements(breaks) b) end
   where id = p_id returning * into s;
  if s.id is null then raise exception 'That shift doesn''t exist.'; end if;
  return public.a3_shift_json(s);
end $$;

-- the Today page: sales today, the last 7 days, who's on the clock
create or replace function public.a3_overview(p_tz text default 'America/New_York') returns jsonb
language sql stable security definer set search_path = public as $$
  with day0 as (select (date_trunc('day', now() at time zone p_tz) at time zone p_tz) as t)
  select jsonb_build_object(
    'today', (select jsonb_build_object('orders', count(*), 'revenue', coalesce(sum(public.a3_amount(o)), 0))
                from orders o, day0 where o.created_at >= day0.t and upper(coalesce(o.status, '')) = 'ACTIVE'),
    'week', (select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'revenue', coalesce(r.rev, 0), 'orders', coalesce(r.n, 0)) order by d), '[]'::jsonb)
               from generate_series((select t from day0) - interval '6 days', (select t from day0), interval '1 day') d
               left join lateral (select sum(public.a3_amount(o)) rev, count(*) n from orders o
                                   where o.created_at >= d and o.created_at < d + interval '1 day' and upper(coalesce(o.status, '')) = 'ACTIVE') r on true),
    'active_subscriptions', (select count(*) from orders where stripe_subscription_id is not null and upper(status) = 'ACTIVE'),
    'on_clock', (select coalesce(jsonb_agg(public.a3_shift_json(s) order by s.clock_in), '[]'::jsonb) from shifts s where s.clock_out is null and s.user_id is not null))
$$;

create or replace function public.a3_log(p_user uuid, p_name text, p_action text, p_details jsonb) returns void
language sql security definer set search_path = public as $$
  insert into staff_log (user_id, name, action, details) values (p_user, p_name, p_action, coalesce(p_details, '{}'::jsonb))
$$;

create or replace function public.a3_log_list(p_limit int default 100) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(l) order by l.at desc), '[]'::jsonb) from (select * from staff_log order by at desc limit least(greatest(p_limit, 1), 500)) l
$$;

-- ============================================================ 8. only the Edge Functions (service key) may call these
do $$
declare f text;
begin
  foreach f in array array['a3_record_order(jsonb)', 'a3_set_status(text, text, text)', 'a3_order_by_session(text)', 'a3_order(text)',
    'a3_orders(text, integer)', 'a3_staff_state(uuid, text)', 'a3_clock_in(uuid, text, text)', 'a3_clock_out(uuid, text, timestamptz)',
    'a3_break(uuid, boolean)', 'a3_shifts(uuid, timestamptz, timestamptz)', 'a3_edit_shift(bigint, timestamptz, timestamptz, text, text)',
    'a3_overview(text)', 'a3_log(uuid, text, text, jsonb)', 'a3_log_list(integer)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
