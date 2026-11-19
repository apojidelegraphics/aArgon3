// Fakes for Stripe, the aARgon3 database (a3_* functions) and Nexus sign-in. Used by functions.test.mjs and by the
// browser smoke test (test/browser/smoke.mjs), which runs the real Edge Function code against them.
import assert from 'node:assert';
import crypto from 'node:crypto';

export const ENV = { SUPABASE_URL: 'https://a3.test', SUPABASE_SERVICE_ROLE_KEY: 'service', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test',
  SITE_URL: 'https://apojidelegraphics.github.io/aArgon3', NEXUS_URL: 'https://nexus.test', NEXUS_KEY: 'pub' };

// One fake world: Stripe, the database (a3_* functions) and Nexus auth.
export function world() {
  const w = { calls: [], rpcs: [], sessions: {}, orders: {}, shift: null, statuses: [], logs: [],
    users: { 'tok-admin': { id: 'u-admin', email: 'sam@apoji.co', level: 'admin', nick: 'Sam' }, 'tok-boss': { id: 'u-boss', email: 'lucas@apoji.co', level: 'high-admin', nick: 'Lucas' },
             'tok-user': { id: 'u-user', email: 'joe@x.co', level: null } } };
  w.stores = [{ code: '0028', name: 'Neo Silicon Valley Flagship (Hub Zero)', region: 'A' }, { code: '2710', name: 'San Francisco Soar Node', region: 'A' },
    { code: '0427', name: 'Raleigh-Durham Omni-Node', region: 'B' }, { code: '0001', name: 'Apoji Corporate Office NC', region: 'E' }];
  w.overview = () => ({ today: { orders: Object.keys(w.orders).length, revenue: Object.values(w.orders).reduce((m, o) => m + (o.amount_cents || 0) / 100, 0) },
    week: [120, 0, 59, 298, 25, 149, 0].map((r, i) => ({ day: new Date(Date.now() - (6 - i) * 864e5).toISOString().slice(0, 10), revenue: i === 6 ? Object.values(w.orders).reduce((m, o) => m + (o.amount_cents || 0) / 100, 0) : r, orders: r ? 1 : 0 })),
    active_subscriptions: 12, on_clock: [w.shift, { id: 3, name: 'Riley', store_code: '0427', clock_in: new Date(Date.now() - 3 * 3600e3).toISOString(), minutes: 171, on_break: true }].filter(Boolean) });
  w.timesheet = user => {
    const day = n => new Date(Date.now() - n * 864e5);
    const row = (n, name, uid, mins, extra = {}) => { const ci = new Date(day(n).setHours(9, 2, 0, 0)); return { id: 100 + n + name.length, user_id: uid, name, store_code: '0028', store: 'Store #0028 – Neo Silicon Valley Flagship (Hub Zero)',
      clock_in: ci.toISOString(), clock_out: new Date(ci.getTime() + (mins + 30) * 6e4).toISOString(), breaks: [{ start: new Date(ci.getTime() + 4 * 3600e3).toISOString(), end: new Date(ci.getTime() + 4.5 * 3600e3).toISOString() }],
      minutes: mins, sales: 149, orders: 2, note: null, forgot: false, edited_by: null, ...extra }; };
    const mine = [row(1, 'Lucas', 'u-boss', 478), row(2, 'Lucas', 'u-boss', 455, { forgot: true, note: 'Forgot to clock out' })];
    return user ? mine.map(r => ({ ...r, user_id: user })) : [...mine, row(1, 'Riley', 'u-r', 492, { edited_by: 'Lucas' }), row(2, 'Sam', 'u-admin', 301)];
  };
  const res = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  w.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    w.calls.push({ url: String(url), method, body: init.body, headers: init.headers });
    if (u.host === 'api.stripe.com') {
      const p = u.pathname.replace('/v1/', '');
      assert.strictEqual(init.headers['Stripe-Version'], '2024-06-20');
      if (p === 'checkout/sessions' && method === 'POST') {
        const f = new URLSearchParams(init.body), id = 'cs_test_' + crypto.randomBytes(4).toString('hex');
        const meta = {}; for (const [k, v] of f) { const m = k.match(/^metadata\[(.+)\]$/); if (m) meta[m[1]] = v; }
        w.sessions[id] = { id, form: f, metadata: meta, status: 'open', payment_status: 'unpaid', amount_total: +f.get('line_items[0][price_data][unit_amount]'), currency: 'usd',
          subscription: 'sub_' + id.slice(-6), customer: 'cus_1', customer_details: { name: 'Pat Doe', email: f.get('customer_email') || 'pat@x.co' } };
        return res({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      if (p.startsWith('checkout/sessions/')) return res(w.sessions[decodeURIComponent(p.split('/')[2])] || {}, w.sessions[decodeURIComponent(p.split('/')[2])] ? 200 : 404);
      if (p.startsWith('subscriptions/') && method === 'GET') return res({ id: 'sub_1', status: 'active', latest_invoice: { payment_intent: 'pi_1' } });
      if (p.startsWith('subscriptions/') && method === 'DELETE') return res({ id: 'sub_1', status: 'canceled' });
      if (p === 'refunds') return res({ id: 're_1', amount: 2500 });
      return res({ error: { message: 'unknown stripe call ' + p } }, 400);
    }
    if (u.host === 'nexus.test') {
      const who = w.users[(init.headers.Authorization || '').replace('Bearer ', '')];
      if (!who) return res({ msg: 'bad jwt' }, 401);
      if (u.pathname === '/auth/v1/user') return res({ id: who.id, email: who.email });
      if (u.pathname === '/rest/v1/rpc/get_my_admin_level') return res(who.level);
      if (u.pathname === '/rest/v1/profiles') return res([{ nickname: who.nick, username: null }]);
    }
    if (u.host === 'a3.test') {
      const name = u.pathname.split('/').pop(), a = JSON.parse(init.body || '{}');
      assert.strictEqual(init.headers.Authorization, 'Bearer service');
      w.rpcs.push({ name, a });
      switch (name) {
        case 'a3_record_order': {
          const p = a.p, dupe = Object.values(w.orders).find(o => p.stripe_session_id && o.stripe_session_id === p.stripe_session_id);
          if (dupe) return res({ order_id: dupe.order_id, created: false });
          w.orders[p.order_id] = { ...p, status: 'ACTIVE' }; return res({ order_id: p.order_id, created: true });
        }
        case 'a3_order_by_session': { const o = Object.values(w.orders).find(o => o.stripe_session_id === a.p_session); return res(o ? { order_id: o.order_id, plan: o.plan_type, config: o.config } : null); }
        case 'a3_order': { const o = w.orders[a.p_order]; return res(o ? { order_id: o.order_id, stripe_subscription_id: o.stripe_subscription_id, status: o.status, plan: o.plan_type, tier: o.tier,
          billing: o.billing, amount: (o.amount_cents || 0) / 100, customer_name: o.customer_name, customer_email: o.customer_email, operator: o.operator, source: o.source,
          created_at: o.created_at || new Date().toISOString(), config: o.config, models: (o.items || []).map(i => i.model), subscription: !!o.stripe_subscription_id } : null); }
        case 'a3_set_status': w.statuses.push(a); return res(1);
        case 'a3_staff_state': return res({ shift: w.shift, stores: w.stores, week_minutes: 1312, last_store: '0028' });
        case 'a3_overview': return res(w.overview());
        case 'a3_clock_in': {
          if (w.shift) return res({ code: 'P0001', message: "You're already clocked in." }, 400);
          const st = w.stores.find(s => s.code === a.p_store) || { code: a.p_store, name: '?' };
          w.shift = { id: 7, user_id: a.p_user, name: a.p_name, store_code: st.code, store: `Store #${st.code} – ${st.name}`, clock_in: new Date().toISOString(), clock_out: null,
            breaks: [], minutes: 0, on_break: false, sales: 0, orders: 0 };
          return res(w.shift);
        }
        case 'a3_clock_out': { const s = { ...w.shift, clock_out: new Date().toISOString(), minutes: 412 }; w.shift = null; return res(s); }
        case 'a3_break': w.shift.on_break = a.p_on; w.shift.breaks = a.p_on ? [{ start: new Date().toISOString(), end: null }] : [{ start: new Date(Date.now() - 6e5).toISOString(), end: new Date().toISOString() }]; return res(w.shift);
        case 'a3_log': w.logs.push(a); return res(null);
        case 'a3_shifts': return res(w.timesheet(a.p_user));
        case 'a3_log_list': return res([]);
        case 'a3_orders': return res(Object.values(w.orders).reverse().map(o => ({ order_id: o.order_id, created_at: o.created_at || new Date().toISOString(), status: o.status,
          plan: o.plan_type, tier: o.tier, billing: o.billing, amount: (o.amount_cents || 0) / 100, customer_name: o.customer_name, customer_email: o.customer_email,
          operator: o.operator, store: o.store, source: o.source, config: o.config, models: (o.items || []).map(i => i.model), subscription: !!o.stripe_subscription_id })));
      }
      return res({ code: 'PGRST202', message: 'function not found' }, 404);
    }
    throw new Error('unexpected fetch ' + url);
  };
  return w;
}
