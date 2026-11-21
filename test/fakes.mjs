// Fakes for Stripe, the aARgon3 database (a3_* functions) and Nexus sign-in. Used by functions.test.mjs and by the
// browser smoke test, which runs the real Edge Function code against them. (The SQL itself is tested for real in
// sql.test.js; rpc.test.js checks every rpc() call matches a real SQL function's arguments.)
import assert from 'node:assert';
import crypto from 'node:crypto';

export const ENV = { SUPABASE_URL: 'https://a3.test', SUPABASE_SERVICE_ROLE_KEY: 'service', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test',
  SITE_URL: 'https://apojidelegraphics.github.io/aArgon3', NEXUS_URL: 'https://nexus.test', NEXUS_KEY: 'pub', OWNER_EMAILS: 'apojidelegraphics101010@gmail.com' };
export const OWNER = 'tok-owner', MANAGER = 'tok-boss', EMPLOYEE = 'tok-admin', OUTSIDER = 'tok-user', INVITED = 'tok-invited';

export function world({ legacy = false } = {}) {
  const now = () => new Date().toISOString();
  const w = { calls: [], rpcs: [], sessions: {}, orders: {}, shifts: {}, statuses: [], logs: [], payments: [], invoices: {}, legacy,
    users: { [OWNER]: { id: 'u-owner', email: 'ApojiDelegraphics101010@gmail.com', level: 'high-admin', nick: 'Lucas' },
             [MANAGER]: { id: 'u-boss', email: 'riley@apoji.co', level: 'high-admin', nick: 'Riley' },
             [EMPLOYEE]: { id: 'u-admin', email: 'sam@apoji.co', level: 'admin', nick: 'Sam' },
             [OUTSIDER]: { id: 'u-user', email: 'joe@x.co', level: null, nick: 'Joe' },
             [INVITED]: { id: 'u-inv', email: 'casey@shop.co', level: null, nick: 'Casey' } },
    staff: [{ id: 9, user_id: null, email: 'casey@shop.co', role: 'employee', active: true, display_name: 'Casey', pay_rate: 14 }],
    schedule: [], timeoff: [], quotes: {}, promos: [], points: [], lateNext: 0,
    // 2.4
    subs: {}, subUpdates: [], credits: [], taxRates: {}, archivedTax: [], emails: [], emailFail: null, attempts: [], closures: [], referrals: [], abandoned: [], invoiceList: [], settings: { store: { open: true, message: '' }, business: { name: 'Apoji Delegraphics' }, goals: { monthly_revenue: 0 } } };
  w.stores = [{ code: '0028', name: 'Neo Silicon Valley Flagship (Hub Zero)', region: 'A', active: true }, { code: '2710', name: 'San Francisco Soar Node', region: 'A', active: true },
    { code: '0427', name: 'Raleigh-Durham Omni-Node', region: 'B', active: true }, { code: '0001', name: 'Apoji Corporate Office NC', region: 'E', active: true }];
  const shiftOf = u => w.shifts[u] || null;
  const staffName = s => s.display_name || s.name || s.email.split('@')[0];
  const staffJson = (s, pay) => { const o = { ...s, name: staffName(s), nexus_name: s.name, signed_in: !!s.user_id }; if (!pay) delete o.pay_rate; return o; };
  w.overview = () => ({ today: { orders: Object.keys(w.orders).length, revenue: Object.values(w.orders).reduce((m, o) => m + (o.amount_cents || 0) / 100, 0) },
    week: [120, 0, 59, 298, 25, 149, 0].map((r, i) => ({ day: new Date(Date.now() - (6 - i) * 864e5).toISOString().slice(0, 10), revenue: i === 6 ? Object.values(w.orders).reduce((m, o) => m + (o.amount_cents || 0) / 100, 0) : r, orders: r ? 1 : 0 })),
    active_subscriptions: 12, on_clock: [...Object.values(w.shifts), { id: 3, name: 'Riley', store_code: '0427', clock_in: new Date(Date.now() - 3 * 3600e3).toISOString(), minutes: 171, on_break: true }] });
  w.timesheet = user => {
    const day = n => new Date(Date.now() - n * 864e5);
    const row = (n, name, uid, mins, extra = {}) => { const ci = new Date(day(n).setHours(9, 2, 0, 0)); return { id: 100 + n + name.length, user_id: uid, name, store_code: '0028', store: 'Store #0028 – Neo Silicon Valley Flagship (Hub Zero)',
      clock_in: ci.toISOString(), clock_out: new Date(ci.getTime() + (mins + 30) * 6e4).toISOString(), breaks: [{ start: new Date(ci.getTime() + 4 * 3600e3).toISOString(), end: new Date(ci.getTime() + 4.5 * 3600e3).toISOString() }],
      minutes: mins, sales: 149, orders: 2, note: null, forgot: false, edited_by: null, ...extra }; };
    const mine = [row(1, 'Lucas', 'u-owner', 478, { late_minutes: 12, scheduled: { starts_at: new Date(day(1).setHours(8, 50, 0, 0)).toISOString() } }), row(2, 'Lucas', 'u-owner', 455, { forgot: true, note: 'Forgot to clock out' })];
    return user ? mine.map(r => ({ ...r, user_id: user })) : [...mine, row(1, 'Riley', 'u-boss', 492, { edited_by: 'Lucas' }), row(2, 'Sam', 'u-admin', 301)];
  };
  const orderJson = o => ({ order_id: o.order_id, created_at: o.created_at || now(), status: o.status, plan: o.plan_type, tier: o.tier, billing: o.billing,
    amount: (o.amount_cents || 0) / 100, customer_name: o.customer_name, customer_email: o.customer_email, customer_phone: o.customer_phone, company_name: o.company_name,
    customer_info: o.customer_info, seats: o.seats, quote_no: o.quote_no, node_id: o.node_id, jurisdiction: o.target_jurisdiction, promo_code: o.promo_code,
    operator: o.operator, store: o.store, source: o.source, config: o.config, models: (o.items || []).map(i => i.model), subscription: !!o.stripe_subscription_id,
    paid_total: (o.amount_cents || 0) / 100, payments: 1,
    region: o.region || null, tax: (o.tax_cents || 0) / 100, current_period_end: o.current_period_end || null, cancel_at: o.cancel_at || null, paused_until: o.paused_until || null,
    expires_at: o.expires_at || null, referral_code: o.referral_code || null, referred_by: o.referred_by || null, gift: o.gift || null, history: o.history || [],
    stripe_customer: !!o.stripe_customer_id, referrals: w.referrals.filter(r => r.referrer_order === o.order_id).length,
    referral_credit: w.referrals.filter(r => r.referrer_order === o.order_id).reduce((m, r) => m + r.credit_cents, 0) / 100 });
  // a subscription the way Stripe returns it (2024-06-20)
  w.sub = id => { const x = w.subs[id] || (w.subs[id] = { id, status: 'active', customer: 'cus_1', current_period_end: Math.floor(Date.now() / 1000) + 20 * 864e2, cancel_at_period_end: false, pause_collection: null,
      metadata: w.subMeta || {}, items: { data: [{ id: 'si_' + id.slice(-4), price: { unit_amount: 2500, recurring: { interval: 'month' }, product: 'prod_' + id.slice(-4) }, tax_rates: [] }] } });
    return { ...x, latest_invoice: { payment_intent: 'pi_1' } }; };
  const res = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const oops = msg => res({ code: 'P0001', message: msg }, 400);
  const form = body => { const f = new URLSearchParams(body || ''), meta = {}; for (const [k, v] of f) { const m = k.match(/^metadata\[(.+)\]$/); if (m) meta[m[1]] = v; } return { f, meta }; };

  w.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    w.calls.push({ url: String(url), method, body: init.body, headers: init.headers });
    if (u.host === 'api.stripe.com') {
      const p = u.pathname.replace('/v1/', '');
      assert.strictEqual(init.headers['Stripe-Version'], '2024-06-20');
      const { f, meta } = form(init.body);
      if (p === 'checkout/sessions' && method === 'POST') {
        const id = 'cs_test_' + crypto.randomBytes(4).toString('hex'), once = f.get('mode') === 'payment';
        const unit = +f.get('line_items[0][price_data][unit_amount]'), txr = w.taxRates[f.get('line_items[0][tax_rates][0]')];
        const off = f.get('discounts[0][promotion_code]') ? 500 : f.get('discounts[0][coupon]') ? (w.coupons?.[f.get('discounts[0][coupon]')] || 0) : 0;
        const tax = txr ? Math.round((unit - off) * txr / 100) : 0;
        w.sessions[id] = { id, form: f, metadata: meta, status: 'open', payment_status: 'unpaid', mode: f.get('mode'), amount_total: unit - off + tax, currency: 'usd',
          subscription: once ? null : 'sub_' + id.slice(-6), invoice: 'in_' + id.slice(-6), customer: 'cus_' + id.slice(-4), customer_details: { name: 'Pat Doe', email: f.get('customer_email') || 'pat@x.co', phone: null },
          total_details: { amount_discount: off, amount_tax: tax }, expires_at: f.get('expires_at') ? +f.get('expires_at') : null };
        return res({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      if (p.startsWith('checkout/sessions/')) { const s = w.sessions[decodeURIComponent(p.split('/')[2])]; return res(s || {}, s ? 200 : 404); }
      if (p.startsWith('subscriptions/') && method === 'GET') return res(w.sub(decodeURIComponent(p.split('/')[1].split('?')[0])));
      if (/^subscriptions\/[^/]+$/.test(p) && method === 'POST') {
        const x = w.sub(p.split('/')[1]); const live = w.subs[x.id];
        w.subUpdates.push({ id: x.id, form: f });
        if (f.has('pause_collection')) live.pause_collection = null;
        if (f.get('pause_collection[behavior]')) live.pause_collection = { behavior: f.get('pause_collection[behavior]'), resumes_at: +f.get('pause_collection[resumes_at]') };
        if (f.has('cancel_at_period_end')) live.cancel_at_period_end = f.get('cancel_at_period_end') === 'true';
        if (f.get('items[0][price_data][unit_amount]')) live.items.data[0].price = { unit_amount: +f.get('items[0][price_data][unit_amount]'), recurring: { interval: f.get('items[0][price_data][recurring][interval]') }, product: f.get('items[0][price_data][product]') };
        return res(w.sub(x.id));
      }
      if (p === 'invoices/upcoming') {
        const x = w.sub(u.searchParams.get('subscription')), old = x.items.data[0].price.unit_amount, nu = +u.searchParams.get('subscription_items[0][price_data][unit_amount]');
        const half = v => Math.round(v / 2);   // halfway through the month
        return res({ amount_due: nu + half(nu) - half(old), total: nu + half(nu) - half(old), lines: { data: [{ proration: true, amount: -half(old) }, { proration: true, amount: half(nu) }, { proration: false, amount: nu }] } });
      }
      if (p === 'invoices' && method === 'GET') return res({ data: w.invoiceList });
      if (/^customers\/[^/]+\/balance_transactions$/.test(p)) { const t = { id: 'cbtxn_' + (w.credits.length + 1), customer: p.split('/')[1], amount: +f.get('amount') }; w.credits.push(t); return res(t); }
      if (p === 'tax_rates') { const id = 'txr_' + f.get('percentage').replace('.', '_') + '_' + Object.keys(w.taxRates).length; w.taxRates[id] = +f.get('percentage'); return res({ id, percentage: +f.get('percentage') }); }
      if (/^tax_rates\//.test(p)) { w.archivedTax.push(p.split('/')[1]); return res({ id: p.split('/')[1], active: false }); }
      if (p === 'billing_portal/sessions') return w.noPortal ? res({ error: { message: 'No configuration provided and your test mode default configuration has not been created.' } }, 400) : res({ url: 'https://billing.stripe.com/p/session/test_' + f.get('customer') });
      if (/^products\/[^/]+$/.test(p)) return res({ id: p.split('/')[1], name: f.get('name') });
      if (p.startsWith('subscriptions/') && method === 'DELETE') return res({ id: 'sub_1', status: 'canceled' });
      if (p === 'refunds') return res({ id: 're_1', amount: 2500 });
      if (p === 'coupons') { const id = 'co_' + f.get('name').replace(/\W+/g, '_') + (f.get('metadata[a3_ref]') ? '_' + crypto.randomBytes(2).toString('hex') : ''); (w.coupons = w.coupons || {})[id] = +f.get('amount_off') || 0; return res({ id, percent_off: f.get('percent_off'), amount_off: f.get('amount_off') }); }
      if (p === 'promotion_codes') return res({ id: 'promo_' + f.get('code'), code: f.get('code'), coupon: f.get('coupon') });
      if (p.startsWith('promotion_codes/')) return res({ id: p.split('/')[1], active: f.get('active') === 'true' });
      if (p === 'customers') return res({ id: 'cus_' + crypto.randomBytes(3).toString('hex'), email: f.get('email') });
      if (p === 'products') return res({ id: 'prod_1', name: f.get('name') });
      if (p === 'invoiceitems') return res({ id: 'ii_1' });
      if (p === 'invoices') { const id = 'in_' + crypto.randomBytes(3).toString('hex'); w.invoices[id] = { id, metadata: meta, form: f }; return res({ id }); }
      if (p === 'subscriptions' && method === 'POST') { const id = 'in_' + crypto.randomBytes(3).toString('hex'); w.invoices[id] = { id, metadata: {}, form: f, subscription: 'sub_inv1' }; w.subMeta = meta; return res({ id: 'sub_inv1', latest_invoice: id, metadata: meta }); }
      if (/^invoices\/[^/]+\/(finalize|send|void)$/.test(p)) return res({ id: p.split('/')[1], hosted_invoice_url: `https://invoice.stripe.com/i/${p.split('/')[1]}` });
      return res({ error: { message: 'unknown stripe call ' + p } }, 400);
    }
    if (u.host === 'api.emailjs.com') {
      const b = JSON.parse(init.body); w.emails.push(b);
      return w.emailFail ? new Response(w.emailFail, { status: 400 }) : new Response('OK', { status: 200 });
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
      if (w.legacy && /^a3_(staff_sync|settings|staff_list|sales|schedule|quote|promo|timeoff)/.test(name)) return res({ code: 'PGRST202', message: 'Could not find the function' }, 404);
      switch (name) {
        // ---- staff
        case 'a3_staff_sync': {
          const e = a.p_email.toLowerCase();
          let s = w.staff.find(x => x.user_id === a.p_user || x.email === e);
          if (!s) { if (!a.p_level && !a.p_owner) return res(null); s = { id: w.staff.length + 10, user_id: a.p_user, email: e, name: a.p_name, role: a.p_owner ? 'owner' : a.p_level === 'high-admin' ? 'manager' : 'employee', active: true }; w.staff.push(s); }
          else { Object.assign(s, { user_id: a.p_user, name: a.p_name }); if (a.p_owner) Object.assign(s, { role: 'owner', active: true }); else if (s.role === 'owner') s.role = 'manager'; }
          return res(staffJson(s, true));
        }
        case 'a3_staff_list': return res(w.staff.map(s => ({ ...staffJson(s, a.p_with_pay), on_clock: shiftOf(s.user_id), week_minutes: 600, month_sales: 149 })));
        case 'a3_staff_get': { const s = w.staff.find(x => x.id === a.p_id); return res(s ? staffJson(s, true) : null); }
        case 'a3_staff_save': {
          const p = a.p;
          if (p.id) { const s = w.staff.find(x => x.id === p.id); for (const k of Object.keys(p)) if (k !== 'id') s[k] = p[k]; return res(staffJson(s, true)); }
          if (w.staff.some(x => x.email === p.email.toLowerCase())) return oops("They're already on the staff list.");
          const s = { id: w.staff.length + 10, user_id: null, email: p.email.toLowerCase(), role: p.role || 'employee', active: true, display_name: p.display_name, pay_rate: p.pay_rate, invited_by: a.p_by };
          w.staff.push(s); return res(staffJson(s, true));
        }
        // ---- schedule & time off
        case 'a3_schedule': return res(w.schedule.filter(c => !a.p_user || c.user_id === a.p_user).map(c => ({ ...c, name: staffName(w.staff.find(s => s.user_id === c.user_id) || { email: 'x@y' }) })));
        case 'a3_schedule_save': { const c = { ...a.p, id: a.p.id || w.schedule.length + 1, created_by: a.p_by }; w.schedule = w.schedule.filter(x => x.id !== c.id).concat(c); return res(c); }
        case 'a3_schedule_delete': w.schedule = w.schedule.filter(x => x.id !== a.p_id); return res(1);
        case 'a3_schedule_copy_week': return res(w.schedule.length);
        case 'a3_timeoff_request': { const t = { id: w.timeoff.length + 1, user_id: a.p_user, starts_on: a.p_starts, ends_on: a.p_ends, reason: a.p_reason, status: 'pending' }; w.timeoff.push(t); return res(t); }
        case 'a3_timeoff': return res(w.timeoff.filter(t => !a.p_user || t.user_id === a.p_user).map(t => ({ ...t, name: staffName(w.staff.find(s => s.user_id === t.user_id) || { email: 'x@y' }) })));
        case 'a3_timeoff_decide': { const t = w.timeoff.find(x => x.id === a.p_id); if (a.p_user && (t.user_id !== a.p_user || a.p_status !== 'cancelled')) return oops("That request can't be changed."); t.status = a.p_status; t.decided_by = a.p_by; return res(t); }
        // ---- orders & payments
        case 'a3_record_order': {
          const p = a.p, dupe = Object.values(w.orders).find(o => (p.stripe_session_id && o.stripe_session_id === p.stripe_session_id) || (p.stripe_invoice_id && o.stripe_invoice_id === p.stripe_invoice_id));
          if (dupe) return res({ order_id: dupe.order_id, created: false });
          w.orders[p.order_id] = { ...p, status: 'ACTIVE', created_at: now() };
          if (p.quote_no && w.quotes[p.quote_no]) Object.assign(w.quotes[p.quote_no], { status: 'paid', order_id: p.order_id });
          if (p.promo_code) { const x = w.promos.find(y => y.code === p.promo_code.toUpperCase()); if (x) x.used++; }
          return res({ order_id: p.order_id, created: true });
        }
        case 'a3_record_payment': { const o = Object.values(w.orders).find(x => x.stripe_subscription_id === a.p_subscription); if (!o) return res({ recorded: false });
          if (!w.payments.some(y => y.invoice === a.p_invoice)) w.payments.push({ invoice: a.p_invoice, order_id: o.order_id, amount: a.p_amount_cents, kind: a.p_kind }); return res({ recorded: true, order_id: o.order_id }); }
        case 'a3_order_by_session': { const o = Object.values(w.orders).find(o => o.stripe_session_id === a.p_session); return res(o ? { order_id: o.order_id, plan: o.plan_type, config: o.config, tier: o.tier, billing: o.billing, email: o.customer_email } : null); }
        case 'a3_order': { const o = w.orders[a.p_order]; return res(o ? { ...orderJson(o), stripe_subscription_id: o.stripe_subscription_id } : null); }
        case 'a3_orders': return res(Object.values(w.orders).reverse().filter(o => !a.p_q || JSON.stringify(o).toLowerCase().includes(a.p_q.toLowerCase())).slice(0, a.p_limit).map(orderJson));
        case 'a3_set_status': w.statuses.push(a); if (a.p_order && w.orders[a.p_order]) w.orders[a.p_order].status = a.p_status; return res(1);
        case 'a3_sales': { const list = Object.values(w.orders).filter(o => !a.p_user || o.staff_user_id === a.p_user);
          return res({ all_time: { revenue: list.reduce((m, o) => m + (o.amount_cents || 0), 0) / 100 + 4107.94, orders: list.length + 68, paid_orders: list.length + 66, comp_orders: list.filter(o => o.source === 'comp').length, renewals: 3 },
            this_month: 1249, mrr: 612.5, active_subscriptions: 12, months: Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String((i + 0) % 12 + 1).padStart(2, '0')}`, revenue: [0, 0, 0, 0, 0, 0, 3120, 4980, 2210, 1890, 2650, 1249][i], orders: [0, 0, 0, 0, 0, 0, 22, 31, 9, 4, 2, 3][i] })),
            by_plan: [{ key: 'Enterprise', orders: 9, revenue: 6820 }, { key: 'Business', orders: 21, revenue: 4410 }, { key: 'Personal', orders: 41, revenue: 2990 }],
            by_tier: [{ key: 'max', orders: 12, revenue: 7300 }, { key: 'pro', orders: 25, revenue: 4100 }, { key: 'plus', orders: 14, revenue: 1820 }, { key: 'standard', orders: 20, revenue: 1000 }],
            by_source: [{ key: 'legacy', orders: 68, revenue: 11950 }, { key: 'terminal', orders: 2, revenue: 154 }, { key: 'web', orders: 1, revenue: 25 }, { key: 'comp', orders: 1, revenue: 0 }],
            top_staff: [{ name: 'Lucas', orders: 61, revenue: 11200 }, { name: 'Riley', orders: 7, revenue: 904 }], top_stores: [{ name: 'Store #0028 – Neo Silicon Valley Flagship (Hub Zero)', orders: 30, revenue: 6100 }] }); }
        // ---- quotes
        case 'a3_quote_save': { const p = a.p, q = w.quotes[p.quote_no] || { status: 'draft', created_at: now() }; Object.assign(q, Object.fromEntries(Object.entries(p).filter(([, v]) => v != null))); q.amount = (q.amount_cents || 0) / 100; w.quotes[p.quote_no] = q; return res(q); }
        case 'a3_quotes': return res(Object.values(w.quotes).filter(q => !a.p_status || q.status === a.p_status).reverse());
        case 'a3_quote': return res(w.quotes[String(a.p_no).toUpperCase()] ? { ...w.quotes[String(a.p_no).toUpperCase()] } : null);
        // ---- 2.4
        case 'a3_order_patch': { const o = w.orders[a.p_order]; if (!o) return oops('Order not found.'); const p = a.p;
          for (const k of ['region', 'tax_cents', 'current_period_end', 'cancel_at', 'paused_until', 'expires_at', 'referred_by', 'gift', 'gift_code', 'tier', 'plan_type', 'billing', 'config', 'items', 'seats', 'amount_cents']) if (k in p) o[k] = p[k];
          if (p.referral_code && !o.referral_code) o.referral_code = p.referral_code;
          if (p.status) o.status = p.status.toUpperCase();
          if (p.event) (o.history = o.history || []).push({ ...p.event, at: now() });
          return res(orderJson(o)); }
        case 'a3_order_stripe': { const o = w.orders[String(a.p_order).toUpperCase()]; return res(o ? { order_id: o.order_id, customer: o.stripe_customer_id || null, subscription: o.stripe_subscription_id || null, email: o.customer_email, status: o.status, tier: o.tier, plan: o.plan_type, quote_no: o.quote_no, source: o.source } : null); }
        case 'a3_subscription_sync': { const list = Object.values(w.orders).filter(o => o.stripe_subscription_id === a.p_subscription && o.status !== 'GIFT');
          for (const o of list) { if (a.p.status) o.status = a.p.status; if (a.p.current_period_end) o.current_period_end = a.p.current_period_end; if ('cancel_at' in a.p) o.cancel_at = a.p.cancel_at; if ('paused_until' in a.p) o.paused_until = a.p.paused_until; }
          return res(list.length); }
        case 'a3_portal_attempt': { if (a.p_failed) for (const k of a.p_keys) w.attempts.push(k); return res(Math.max(0, ...a.p_keys.map(k => w.attempts.filter(x => x === k).length))); }
        case 'a3_portal_order': { const o = w.orders[String(a.p_order).toUpperCase().trim()], e = String(a.p_email).trim().toLowerCase();
          return res(o && o.status !== 'GIFT' && [o.customer_email, o.customer_info?.billing_email, o.gift?.to_email].filter(Boolean).map(x => x.toLowerCase()).includes(e) ? orderJson(o) : null); }
        case 'a3_gift': { const o = Object.values(w.orders).find(x => x.gift_code && x.gift_code === String(a.p_code).toUpperCase().trim());
          return res(o ? { code: o.gift_code, plan: o.plan_type, tier: o.tier, months: o.gift.months, claimed: o.status !== 'GIFT', from_name: o.gift.from_name, to_name: o.gift.to_name, message: o.gift.message } : null); }
        case 'a3_gift_claim': { const o = Object.values(w.orders).find(x => x.gift_code === a.p_code); if (!o) return oops("That gift code isn't right."); if (o.status !== 'GIFT') return oops('That gift has already been claimed.');
          Object.assign(o, { status: 'ACTIVE', customer_email: a.p_customer.email.toLowerCase(), customer_name: `${a.p_customer.first} ${a.p_customer.last || ''}`.trim(), customer_info: a.p_customer,
            expires_at: new Date(Date.now() + o.gift.months * 30 * 864e5).toISOString(), gift: { ...o.gift, claimed_at: now() } }); return res(orderJson(o)); }
        case 'a3_expire': return res(0);
        case 'a3_referrer': { const o = Object.values(w.orders).find(x => x.referral_code === String(a.p_code).toUpperCase() && ['ACTIVE', 'PAID', 'PAUSED'].includes(x.status));
          return res(o ? { order_id: o.order_id, email: (o.customer_email || '').toLowerCase(), customer: o.stripe_customer_id || null, subscription: o.stripe_subscription_id || null, plan: o.plan_type, tier: o.tier, status: o.status, name: o.customer_name,
            this_year: w.referrals.filter(r => r.code === o.referral_code && r.status === 'credited').length } : null); }
        case 'a3_referral_record': { if (w.referrals.some(r => r.new_order === a.p.new_order)) return res({ recorded: false }); const r = { ...a.p, credit_cents: a.p.credit_cents || 0 }; w.referrals.push(r); return res({ ...r, recorded: true }); }
        case 'a3_referrals': return res(w.referrals.slice().reverse());
        case 'a3_abandoned_save': { if (w.abandoned.some(x => x.session_id === a.p.session_id)) return res({ saved: false, reason: 'seen' });
          if (Object.values(w.orders).some(o => (o.customer_email || '').toLowerCase() === a.p.email.toLowerCase())) return res({ saved: false, reason: 'already bought' });
          w.abandoned.push({ ...a.p, email: a.p.email.toLowerCase(), created_at: now() }); return res({ saved: true }); }
        case 'a3_abandoned_mark': { const x = w.abandoned.find(y => y.session_id === a.p_session); if (x) { x.email_error = a.p_error; if (!a.p_error) x.emailed_at = now(); } return res(null); }
        case 'a3_abandoned': return res(w.abandoned.slice().reverse());
        case 'a3_stores_public': return res({ stores: w.stores.filter(x => x.active).map(x => ({ code: x.code, name: x.name, region: x.region, hours: x.hours || null })), closures: w.closures });
        case 'a3_store_hours': { const st = w.stores.find(x => x.code === a.p_code); if (!st) return oops(`No store #${a.p_code}.`); st.hours = a.p_hours; return res({ stores: w.stores, closures: w.closures }); }
        case 'a3_closure_save': { const p = a.p; if (p.ends_on < p.starts_on) return oops('The closure has to end on or after the day it starts.');
          if (p.id) Object.assign(w.closures.find(c => c.id === p.id), p); else w.closures.push({ id: w.closures.length + 1, store_code: p.store_code || null, starts_on: p.starts_on, ends_on: p.ends_on, reason: p.reason });
          return res({ stores: w.stores, closures: w.closures }); }
        case 'a3_closure_delete': w.closures = w.closures.filter(c => c.id !== a.p_id); return res({ stores: w.stores, closures: w.closures });
        case 'a3_quote_request': { const p = a.p, em = p.customer.email.toLowerCase();
          if (Object.values(w.quotes).filter(q => q.source === 'web' && q.customer?.email?.toLowerCase() === em).length >= 3) return oops("We already have your requests. We'll be in touch soon.");
          w.quotes[p.quote_no] = { ...p, status: 'requested', source: 'web', amount_cents: 0, amount: 0, created_by: 'Website', created_at: now() }; return res({ quote_no: p.quote_no }); }
        // ---- points
        case 'a3_points_board': { const rows = w.staff.filter(x => x.active && x.user_id).map(x => { const mine = w.points.filter(p => p.user_id === x.user_id && !p.undone);
            return { user_id: x.user_id, name: staffName(x), role: x.role, color: x.color, title: x.title, total: mine.reduce((m, p) => m + p.points, 0),
              month: mine.filter(p => p.created_at >= a.p_month_start).reduce((m, p) => m + p.points, 0), given: mine.filter(p => p.points > 0).reduce((m, p) => m + p.points, 0),
              taken: mine.filter(p => p.points < 0).reduce((m, p) => m + p.points, 0), last: mine.at(-1)?.created_at || null }; });
          return res(rows.sort((x, y) => y.total - x.total)); }
        case 'a3_points': return res(w.points.filter(p => !a.p_user || p.user_id === a.p_user).slice().reverse().slice(0, a.p_limit).map(p => ({ ...p, name: staffName(w.staff.find(x => x.user_id === p.user_id) || { email: 'x@y' }) })));
        case 'a3_points_give': { if (!w.staff.some(x => x.user_id === a.p_user && x.active)) return oops("That person isn't on the team.");
          const x = { id: w.points.length + 1, user_id: a.p_user, points: a.p_points, reason: a.p_reason, kind: a.p_kind, given_by: a.p_by, given_by_id: a.p_by_id, undone: false, created_at: now() };
          w.points.push(x); return res({ ...x }); }
        case 'a3_points_undo': { const x = w.points.find(p => p.id === a.p_id && !p.undone); if (!x) return oops('Already undone, or not found.'); x.undone = true; x.undone_by = a.p_by; return res({ ...x }); }
        // ---- promotions
        case 'a3_promos': return res(w.promos);
        case 'a3_promo': return res(w.promos.find(x => x.code === a.p_code) || null);
        case 'a3_promo_save': { const p = a.p; if (p.id) { const x = w.promos.find(y => y.id === p.id); if ('active' in p) x.active = x.live = p.active; return res(x); }
          const x = { id: w.promos.length + 1, code: p.code, type: p.type, value: p.value, duration: p.duration, duration_months: p.duration_months, plans: p.plans, tiers: p.tiers, min_total: p.min_total,
            limit: p.limit, used: 0, active: true, live: true, stripe_promo_id: p.stripe_promo_id, description: p.description, created_by: p.created_by }; w.promos.push(x); return res(x); }
        // ---- settings & stores
        case 'a3_settings': return res(w.settings);
        case 'a3_setting_set': w.settings[a.p_key] = a.p_value; return res(w.settings);
        case 'a3_stores_all': return res(w.stores);
        case 'a3_store_save': { const s = { code: a.p_code, name: a.p_name, region: a.p_region, active: a.p_active }; w.stores = w.stores.filter(x => x.code !== s.code).concat(s); return res(s); }
        // ---- clock
        case 'a3_staff_state': return res({ shift: shiftOf(a.p_user), stores: w.stores, week_minutes: 1312, last_store: '0028', pending_time_off: w.timeoff.filter(t => t.status === 'pending').length,
          upcoming: w.schedule.filter(c => c.user_id === a.p_user) });
        case 'a3_overview': return res(w.overview());
        case 'a3_clock_in': {
          if (shiftOf(a.p_user)) return oops("You're already clocked in.");
          const st = w.stores.find(s => s.code === a.p_store) || { code: a.p_store, name: '?' };
          w.shifts[a.p_user] = { id: 7, user_id: a.p_user, name: a.p_name, store_code: st.code, store: `Store #${st.code} – ${st.name}`, clock_in: now(), clock_out: null, breaks: [], minutes: 0, on_break: false, sales: 0, orders: 0, late_minutes: w.lateNext || 0 };
          return res(w.shifts[a.p_user]);
        }
        case 'a3_clock_out': { const s = { ...shiftOf(a.p_user), clock_out: now(), minutes: 412 }; delete w.shifts[a.p_user]; return res(s); }
        case 'a3_break': { const s = shiftOf(a.p_user); s.on_break = a.p_on; s.breaks = a.p_on ? [{ start: now(), end: null }] : [{ start: new Date(Date.now() - 6e5).toISOString(), end: now() }]; return res(s); }
        case 'a3_edit_shift': return res({ id: a.p_id, name: 'Sam', clock_in: a.p_clock_in, clock_out: a.p_clock_out, edited_by: a.p_by });
        case 'a3_log': w.logs.push(a); return res(null);
        case 'a3_shifts': return res(w.timesheet(a.p_user));
        case 'a3_log_list': return res(w.logs.map((l, i) => ({ id: i, at: now(), name: l.p_name, action: l.p_action, details: l.p_details })).reverse());
      }
      return res({ code: 'PGRST202', message: 'function not found' }, 404);
    }
    throw new Error('unexpected fetch ' + url);
  };
  return w;
}
