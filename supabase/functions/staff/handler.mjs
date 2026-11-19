// POST /functions/v1/staff — everything the staff terminal (web and desktop) does.
// Staff sign in with their Nexus account. Every request carries that account's access token; this function checks it
// with the Nexus project and only answers accounts listed in Nexus's admin_roles (any level). "high-admin" accounts are
// managers: they also see everyone's timesheets, fix shifts, give free (comp) orders and cancel or refund orders.
//
// Body: { action, ... }
//   me                                   your account, your shift, stores, today's numbers
//   clock_in { store } · clock_out { note, at } · break { on }
//   shifts { from, to, everyone }        timesheet (everyone: managers only)
//   edit_shift { id, clock_in, clock_out, note }                       managers
//   sale { plan, tier, billing, os, connection, email }  → { url, order_id, … }  a Stripe link + QR for the customer
//   sale_status { session_id }           has the customer paid yet?
//   comp { plan, tier, os, connection, email, name, note }             managers: a free order, no payment
//   orders { q } · order { order_id }
//   cancel { order_id, refund }          managers: cancels the subscription in Stripe (and refunds the last payment)
//   log                                  managers: who did what
import { A3, cors, json, Oops, db, stripe, startCheckout, sessionStatus, newOrderId } from '../_shared/lib.mjs';

const NEXUS_URL = 'https://yzbnxpkuhlxsuwzbjifx.supabase.co';
const NEXUS_KEY = 'sb_publishable_LY-EZORCvEQqW6AeQC5a8w_Z7wmeyjn';   // public key, safe to ship
const TZ = 'America/New_York';

export function handler(env, fetchImpl = fetch, now = () => Date.now()) {
  const rpc = db(env, fetchImpl), call = stripe(env, fetchImpl);
  const nexusUrl = env.NEXUS_URL || NEXUS_URL, nexusKey = env.NEXUS_KEY || NEXUS_KEY;
  const site = env.SITE_URL || 'https://apojidelegraphics.github.io/aArgon3';
  const cache = new Map();   // token → { who, until }

  async function nexus(path, token, init = {}) {
    const res = await fetchImpl(`${nexusUrl}${path}`, { ...init, headers: { apikey: nexusKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }
  // Who is this? (cached for 5 minutes so the clock and order lists stay quick)
  async function whoIs(req) {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) throw new Oops('Sign in first.', 401);
    const hit = cache.get(token);
    if (hit && hit.until > now()) return hit.who;
    const user = await nexus('/auth/v1/user', token);
    if (!user?.id) throw new Oops('Your sign-in expired. Sign in again.', 401);
    const level = await nexus('/rest/v1/rpc/get_my_admin_level', token, { method: 'POST', body: '{}' });
    if (!level || typeof level !== 'string') throw new Oops("That account isn't an admin, so it can't use aARgon3.", 403);
    const prof = (await nexus(`/rest/v1/profiles?select=username,nickname&id=eq.${encodeURIComponent(user.id)}`, token)) || [];
    const name = prof[0]?.nickname || prof[0]?.username || String(user.email || 'Staff').split('@')[0];
    const who = { id: user.id, email: user.email, name, level, manager: level === 'high-admin' };
    cache.set(token, { who, until: now() + 5 * 60e3 });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return who;
  }
  const needManager = who => { if (!who.manager) throw new Oops('Only managers (high-admins) can do that.', 403); };
  const log = (who, action, details) => rpc('a3_log', { p_user: who.id, p_name: who.name, p_action: action, p_details: details }).catch(() => {});
  const iso = (v, what) => { const d = new Date(v); if (!v || isNaN(d)) throw new Oops(`Pick a ${what}.`); return d.toISOString(); };

  const actions = {
    async me(who) {
      const [state, overview] = await Promise.all([rpc('a3_staff_state', { p_user: who.id, p_tz: TZ }), rpc('a3_overview', { p_tz: TZ })]);
      return { user: who, state, overview, catalog: A3.C.version };
    },
    async overview() { return rpc('a3_overview', { p_tz: TZ }); },
    async clock_in(who, b) { return rpc('a3_clock_in', { p_user: who.id, p_name: who.name, p_store: String(b.store || '') }); },
    async clock_out(who, b) {
      return rpc('a3_clock_out', { p_user: who.id, p_note: b.note ? String(b.note).slice(0, 500) : null, p_at: b.at ? iso(b.at, 'time') : null });
    },
    async break(who, b) { return rpc('a3_break', { p_user: who.id, p_on: !!b.on }); },
    async shifts(who, b) {
      const from = iso(b.from, 'start date'), to = iso(b.to, 'end date');
      if (new Date(to) - new Date(from) > 93 * 864e5) throw new Oops('Pick 3 months or less.');
      if (b.everyone) needManager(who);
      return rpc('a3_shifts', { p_user: b.everyone ? null : who.id, p_from: from, p_to: to });
    },
    async edit_shift(who, b) {
      needManager(who);
      const r = await rpc('a3_edit_shift', { p_id: Number(b.id), p_clock_in: iso(b.clock_in, 'clock-in time'), p_clock_out: b.clock_out ? iso(b.clock_out, 'clock-out time') : null,
        p_note: b.note ? String(b.note).slice(0, 500) : null, p_by: who.name });
      await log(who, 'edit_shift', { id: Number(b.id), name: r?.name, clock_in: r?.clock_in, clock_out: r?.clock_out });
      return r;
    },
    async sale(who, b) {
      const state = await rpc('a3_staff_state', { p_user: who.id, p_tz: TZ });
      if (!state?.shift) throw new Oops('Clock in before you start a sale.');
      const sel = A3.selection(b);
      const r = await startCheckout({ call, siteUrl: site, sel, staff: { id: who.id, name: who.name, shiftId: state.shift.id } });
      await log(who, 'sale_link', { order_id: r.order_id, plan: sel.plan, tier: sel.tier, billing: sel.billing, amount: r.amount });
      return r;
    },
    async sale_status(who, b) { return sessionStatus({ rpc, call, sessionId: b.session_id }); },
    async comp(who, b) {
      needManager(who);
      const sel = A3.selection({ ...b, billing: 'month' });
      const state = await rpc('a3_staff_state', { p_user: who.id, p_tz: TZ });
      const order_id = newOrderId();
      await rpc('a3_record_order', { p: { order_id, plan_type: A3.C.plans[sel.plan].name, tier: sel.tier, billing: 'comp', config: A3.config(sel), items: A3.items(sel.tier),
        amount_cents: 0, customer_name: String(b.name || '').slice(0, 120), customer_email: sel.email, source: 'comp', staff_user_id: who.id, operator: who.name,
        shift_id: state?.shift?.id || null, payment_method: 'comp', notes: b.note ? String(b.note).slice(0, 500) : null } });
      await log(who, 'comp', { order_id, plan: sel.plan, tier: sel.tier, note: b.note || '' });
      return { order_id };
    },
    async orders(who, b) { return rpc('a3_orders', { p_q: String(b.q || '').slice(0, 100), p_limit: 100 }); },
    async order(who, b) {
      const o = await rpc('a3_order', { p_order: String(b.order_id || '') });
      if (!o) throw new Oops('No order has that number.', 404);
      delete o.stripe_subscription_id; return o;
    },
    async cancel(who, b) {
      needManager(who);
      const o = await rpc('a3_order', { p_order: String(b.order_id || '') });
      if (!o) throw new Oops('No order has that number.', 404);
      let refunded = null;
      if (o.stripe_subscription_id) {
        const sub = await call('GET', `subscriptions/${encodeURIComponent(o.stripe_subscription_id)}?expand[]=latest_invoice`);
        if (b.refund) {
          const pi = sub.latest_invoice?.payment_intent;
          if (pi) { const r = await call('POST', 'refunds', { payment_intent: typeof pi === 'string' ? pi : pi.id }); refunded = (r.amount || 0) / 100; }
        }
        if (sub.status !== 'canceled') await call('DELETE', `subscriptions/${encodeURIComponent(o.stripe_subscription_id)}`);
      }
      await rpc('a3_set_status', { p_order: o.order_id, p_subscription: null, p_status: b.refund ? 'REFUNDED' : 'CANCELLED' });
      await log(who, b.refund ? 'refund' : 'cancel', { order_id: o.order_id, refunded });
      return { order_id: o.order_id, status: b.refund ? 'REFUNDED' : 'CANCELLED', refunded };
    },
    async log(who) { needManager(who); return rpc('a3_log_list', { p_limit: 200 }); }
  };

  return async function (req) {
    const h = cors(req);
    if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405, h);
    try {
      const b = await req.json().catch(() => ({}));
      const fn = Object.hasOwn(actions, b.action) ? actions[b.action] : null;
      if (!fn) throw new Oops('Unknown action.');
      const who = await whoIs(req);
      return json(await fn(who, b) ?? null, 200, h);
    } catch (e) {
      const status = e instanceof Oops ? e.status : 400;
      if (status >= 500) console.error('[staff]', e);
      return json({ error: e.message || 'Something went wrong.' }, status, h);
    }
  };
}
