-- aARgon3 2.6, the Nexus side. Run this in the NEXUS project (Nexus Backend, yzbnxpkuhlxsuwzbjifx) → SQL Editor,
-- after nexus-v4.0.4.sql. Safe to run again. It only adds to what Nexus 4.0 already has:
--   1) the terminal says "I'm here" with presence_ping('aargon3', version), so aARgon3 shows in your Apoji account's apps
--      (apoji_account) and in Apoji Admin next to Mac / Windows / N28C / Test Run;
--   2) the status page gets aARgon3 parts (store and terminal), so incidents can say they affect aARgon3, and their
--      known issues and fixing release show up inside aARgon3;
--   3) apoji_public_profile also returns the 4.0.4 look (display name, name colors, profile frame), which aARgon3 shows
--      when a customer links their Nexus account to an order.

-- 1) aARgon3 as a place you use your Apoji account
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.user_presence'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%surface%' loop
    execute format('alter table public.user_presence drop constraint %I', c);
  end loop;
  alter table public.user_presence add constraint user_presence_surface_check check (surface in ('mac', 'windows', 'linux', 'test_run', 'phone', 'admin', 'aargon3'));
end $$;

create or replace function public.presence_ping(p_surface text, p_version text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare fresh boolean;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false); end if;
  if p_surface not in ('mac', 'windows', 'linux', 'test_run', 'phone', 'admin', 'aargon3') then return jsonb_build_object('ok', false, 'error', 'bad_surface'); end if;
  insert into user_presence (user_id, surface, version) values (auth.uid(), p_surface, left(coalesce(p_version, ''), 40))
  on conflict (user_id, surface) do update set seen_at = now(), version = excluded.version
  returning (xmax = 0) into fresh;
  if fresh then
    insert into user_events (user_id, kind, detail) values (auth.uid(), 'first_seen', jsonb_build_object('surface', p_surface, 'version', p_version));
    -- a Test Run person who just installed the Mac or Windows app
    if p_surface in ('mac', 'windows') and exists (select 1 from user_presence where user_id = auth.uid() and surface = 'test_run') then
      insert into user_events (user_id, kind, detail) values (auth.uid(), 'got_app', jsonb_build_object('surface', p_surface, 'version', p_version));
    end if;
  end if;
  update profiles set last_active_at = now() where id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.presence_ping(text, text) from public, anon;
grant execute on function public.presence_ping(text, text) to authenticated;

-- 2) aARgon3 on the status page (after Nexus's own parts)
insert into public.status_components (key, label, description, position) values
  ('aargon3_store', 'aARgon3 store', 'Plans, checkout, deals and Your order', 20),
  ('aargon3_terminal', 'aARgon3 terminal', 'The staff terminal on the web, Mac and Windows', 21)
on conflict (key) do nothing;

-- 3) the public look of an account, now with the 4.0.4 extras (still nothing private: no email, no id)
create or replace function public.apoji_public_profile(p_username text default null, p_code text default null, p_app text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if p_code is not null then
    select user_id into uid from apoji_link_codes where code = upper(p_code) and used_at is null and created_at > now() - interval '15 minutes';
    if uid is not null then update apoji_link_codes set used_at = now(), used_by = left(coalesce(p_app, ''), 40) where code = upper(p_code); end if;
  elsif p_username is not null then select id into uid from profiles where lower(username) = lower(trim(leading '@' from p_username));
  end if;
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'profile', (select jsonb_build_object('username', p.username, 'nickname', coalesce(p.nickname, ''), 'avatar_url', p.avatar_url,
    'frame', s.frame, 'font', s.font, 'color', s.color, 'ptheme', s.ptheme, 'banner', s.banner, 'bio', coalesce(s.bio, ''), 'owner', p.id = any(public.app_owner_ids()),
    'display_name', coalesce(s.display_name, ''), 'name_a', s.name_a, 'name_b', s.name_b, 'pframe', s.pframe, 'pronouns', coalesce(s.pronouns, ''))
    from profiles p left join profile_style s on s.user_id = p.id where p.id = uid));
end $$;
grant execute on function public.apoji_public_profile(text, text, text) to anon, authenticated;
