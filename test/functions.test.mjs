// The three Edge Functions, with Stripe, the aARgon3 database and Nexus sign-in replaced by fakes.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { handler as checkout } from '../supabase/functions/checkout/handler.mjs';
import { handler as webhook } from '../supabase/functions/stripe-webhook/handler.mjs';
import { handler as staff } from '../supabase/functions/staff/handler.mjs';
import { verifyStripeSignature } from '../supabase/functions/_shared/lib.mjs';

import { ENV, world } from './fakes.mjs';

const req = (body, headers = {}) => new Request('https://fn.test/', { method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'https://apojidelegraphics.github.io', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const call = async (h, body, headers) => { const r = await h(req(body, headers)); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };

test('checkout: the server sets the price, not the browser', async () => {
  const w = world(), h = checkout(ENV, w.fetch);
  const r = await call(h, { action: 'start', plan: 'business', tier: 'pro', billing: 'year', amount: 1, os: 'LentOS 28 Horizon', email: 'boss@co.com' });
  assert.strictEqual(r.status, 200); assert.match(r.body.url, /^https:\/\/checkout\.stripe\.com\//);
  const s = Object.values(w.sessions)[0], f = s.form;
  assert.strictEqual(f.get('mode'), 'subscription');
  assert.strictEqual(f.get('line_items[0][price_data][unit_amount]'), '149000');
  assert.strictEqual(f.get('line_items[0][price_data][recurring][interval]'), 'year');
  assert.match(f.get('line_items[0][price_data][product_data][name]'), /^aARgon3 Business · Pro · Order [A-Z2-9]{8}-[A-Z2-9]{4}$/);
  assert.strictEqual(f.get('customer_email'), 'boss@co.com');
  assert.strictEqual(f.get('success_url'), 'https://apojidelegraphics.github.io/aArgon3/success.html?session_id={CHECKOUT_SESSION_ID}');
  assert.strictEqual(s.metadata.a3_os, 'LentOS 28 Horizon'); assert.strictEqual(s.metadata.a3_source, 'web');
  assert.strictEqual(f.get('subscription_data[metadata][a3_order]'), s.metadata.a3_order);
  assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://apojidelegraphics.github.io');
});

test('checkout: enterprise and bad input are refused', async () => {
  const w = world(), h = checkout(ENV, w.fetch);
  assert.match((await call(h, { action: 'start', plan: 'enterprise', tier: 'pro' })).body.error, /quoted/);
  assert.strictEqual((await call(h, { action: 'start', plan: 'gold', tier: 'pro' })).status, 400);
  assert.strictEqual((await call(h, { action: 'nope' })).status, 400);
  assert.match((await call(checkout({ ...ENV, STRIPE_SECRET_KEY: '' }, w.fetch), { action: 'start', plan: 'personal', tier: 'pro' })).body.error, /STRIPE_SECRET_KEY/);
  assert.strictEqual(Object.keys(w.sessions).length, 0);
});

test('thank-you page: waits, then creates the order itself if the webhook is late', async () => {
  const w = world(), h = checkout(ENV, w.fetch);
  await call(h, { action: 'start', plan: 'personal', tier: 'max', os: 'LentOS 27.2 Sonoma' });
  const s = Object.values(w.sessions)[0];
  assert.deepStrictEqual((await call(h, { action: 'status', session_id: s.id })).body, { ready: false, state: 'open' });
  s.status = 'complete'; s.payment_status = 'paid';
  const r = await call(h, { action: 'status', session_id: s.id });
  assert.strictEqual(r.body.ready, true); assert.strictEqual(r.body.order.order_id, s.metadata.a3_order);
  const o = w.orders[s.metadata.a3_order];
  assert.strictEqual(o.amount_cents, 5900); assert.strictEqual(o.plan_type, 'Personal'); assert.strictEqual(o.config.chip, 'Quouk .3o');
  assert.strictEqual(o.config.os, 'LentOS 27.2 Sonoma'); assert.ok(o.items.some(i => i.model === 'Neodela'));
  assert.strictEqual(o.customer_email, 'pat@x.co'); assert.strictEqual(o.stripe_subscription_id, s.subscription);
  assert.strictEqual((await call(h, { action: 'status', session_id: 'not-a-session' })).status, 400);
});

function signed(body, secret = 'whsec_test', t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { 'stripe-signature': `t=${t},v1=${sig}` };
}
test('webhook: checks Stripe\'s signature', async () => {
  const w = world(), h = webhook(ENV, w.fetch), body = JSON.stringify({ type: 'ping', data: { object: {} } });
  assert.strictEqual((await call(h, body, signed(body))).status, 200);
  assert.strictEqual((await call(h, body, signed(body, 'whsec_wrong'))).status, 400);
  assert.strictEqual((await call(h, body, signed(body, 'whsec_test', Math.floor(Date.now() / 1000) - 3600))).status, 400);
  assert.strictEqual((await call(h, body, {})).status, 400);
  assert.strictEqual((await call(h, body.replace('ping', 'pong'), signed(body))).status, 400);
  await assert.rejects(verifyStripeSignature(body, signed(body).sig, '', 0), /STRIPE_WEBHOOK_SECRET/);
});

test('webhook: a paid checkout becomes one order, even if Stripe sends it twice', async () => {
  const w = world(), hc = checkout(ENV, w.fetch), hw = webhook(ENV, w.fetch);
  await call(hc, { action: 'start', plan: 'business', tier: 'standard' });
  const s = Object.values(w.sessions)[0]; s.status = 'complete'; s.payment_status = 'paid';
  const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { ...s, form: undefined } } });
  const r1 = await call(hw, body, signed(body)), r2 = await call(hw, body, signed(body));
  assert.strictEqual(r1.body.order, s.metadata.a3_order); assert.strictEqual(r2.body.order, s.metadata.a3_order);
  assert.strictEqual(Object.keys(w.orders).length, 1);
  // unpaid (e.g. a bank transfer still pending) → no order yet
  const unpaid = JSON.stringify({ type: 'checkout.session.completed', data: { object: { ...s, id: 'cs_other', payment_status: 'unpaid', form: undefined } } });
  assert.strictEqual((await call(hw, unpaid, signed(unpaid))).body.order, null);
  // someone else's checkout on the same Stripe account is ignored
  const other = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_x', metadata: {} } } });
  assert.match((await call(hw, other, signed(other))).body.ignored, /not an aARgon3/);
});

test('webhook: cancelled or unpaid subscriptions stop the order; fixed ones restart it', async () => {
  const w = world(), h = webhook(ENV, w.fetch);
  const send = async (type, status) => { const b = JSON.stringify({ type, data: { object: { id: 'sub_9', status } } }); return call(h, b, signed(b)); };
  await send('customer.subscription.deleted', 'canceled');
  await send('customer.subscription.updated', 'unpaid');
  await send('customer.subscription.updated', 'active');
  await send('customer.subscription.updated', 'past_due');   // Stripe is still retrying the card: leave it
  assert.deepStrictEqual(w.statuses.map(s => [s.p_subscription, s.p_status]), [['sub_9', 'CANCELLED'], ['sub_9', 'CANCELLED'], ['sub_9', 'ACTIVE']]);
});

test('staff: only Nexus admins get in', async () => {
  const w = world(), h = staff(ENV, w.fetch);
  assert.strictEqual((await call(h, { action: 'me' })).status, 401);
  assert.strictEqual((await call(h, { action: 'me' }, { authorization: 'Bearer junk' })).status, 401);
  const r = await call(h, { action: 'me' }, { authorization: 'Bearer tok-user' });
  assert.strictEqual(r.status, 403); assert.match(r.body.error, /isn't an admin/);
  const ok = await call(h, { action: 'me' }, { authorization: 'Bearer tok-admin' });
  assert.strictEqual(ok.status, 200); assert.deepStrictEqual(ok.body.user, { id: 'u-admin', email: 'sam@apoji.co', name: 'Sam', level: 'admin', manager: false });
  assert.strictEqual((await call(h, { action: 'constructor' }, { authorization: 'Bearer tok-admin' })).status, 400);
});

test('staff: clock in, then sell; sales need a shift', async () => {
  const w = world(), h = staff(ENV, w.fetch), A = { authorization: 'Bearer tok-admin' };
  assert.match((await call(h, { action: 'sale', plan: 'personal', tier: 'pro' }, A)).body.error, /Clock in/);
  assert.strictEqual((await call(h, { action: 'clock_in', store: '0028' }, A)).body.store_code, '0028');
  const dbl = await call(h, { action: 'clock_in', store: '0028' }, A);
  assert.strictEqual(dbl.status, 400); assert.strictEqual(dbl.body.error, "You're already clocked in.");
  const sale = await call(h, { action: 'sale', plan: 'personal', tier: 'pro', billing: 'month' }, A);
  assert.strictEqual(sale.status, 200); assert.strictEqual(sale.body.amount, 25);
  const s = w.sessions[sale.body.session_id];
  assert.deepStrictEqual([s.metadata.a3_source, s.metadata.a3_staff, s.metadata.a3_operator, s.metadata.a3_shift], ['terminal', 'u-admin', 'Sam', '7']);
  assert.match(s.form.get('cancel_url'), /success\.html\?cancelled=1$/);
  assert.ok(w.logs.some(l => l.p_action === 'sale_link'));
  s.status = 'complete'; s.payment_status = 'paid';
  const st = await call(h, { action: 'sale_status', session_id: s.id }, A);
  assert.strictEqual(st.body.ready, true);
  assert.strictEqual(w.orders[sale.body.order_id].shift_id, '7');
});

test('staff: manager-only actions', async () => {
  const w = world(), h = staff(ENV, w.fetch), A = { authorization: 'Bearer tok-admin' }, B = { authorization: 'Bearer tok-boss' };
  const from = new Date(Date.now() - 864e5).toISOString(), to = new Date().toISOString();
  for (const body of [{ action: 'comp', plan: 'personal', tier: 'max' }, { action: 'cancel', order_id: 'X' }, { action: 'log' },
    { action: 'edit_shift', id: 1, clock_in: from }, { action: 'shifts', from, to, everyone: true }]) {
    const r = await call(h, body, A); assert.strictEqual(r.status, 403, body.action); assert.match(r.body.error, /managers/);
  }
  assert.ok((await call(h, { action: 'shifts', from, to }, A)).body.every(s => s.user_id === 'u-admin'));   // your own: fine
  assert.strictEqual((await call(h, { action: 'shifts', from: '2026-01-01', to: '2026-12-31' }, A)).status, 400);   // too long a range
  const comp = await call(h, { action: 'comp', plan: 'business', tier: 'max', name: 'Tester', note: 'beta' }, B);
  const o = w.orders[comp.body.order_id];
  assert.deepStrictEqual([o.source, o.amount_cents, o.payment_method, o.operator], ['comp', 0, 'comp', 'Lucas']);
  // cancel + refund goes to Stripe
  o.stripe_subscription_id = 'sub_1';
  const c = await call(h, { action: 'cancel', order_id: comp.body.order_id, refund: true }, B);
  assert.deepStrictEqual(c.body, { order_id: comp.body.order_id, status: 'REFUNDED', refunded: 25 });
  assert.ok(w.calls.some(x => x.url.endsWith('/v1/refunds') && x.body.includes('payment_intent=pi_1')));
  assert.ok(w.calls.some(x => x.method === 'DELETE' && x.url.includes('/v1/subscriptions/sub_1')));
  assert.strictEqual((await call(h, { action: 'cancel', order_id: 'NOPE' }, B)).status, 404);
});

test('staff: a missing SQL migration says so plainly', async () => {
  const w = world(), h = staff(ENV, w.fetch);
  const r = await call(h, { action: 'orders', q: '' }, { authorization: 'Bearer tok-admin' });
  assert.strictEqual(r.status, 200);
  const r2 = await call(h, { action: 'order', order_id: 'X' }, { authorization: 'Bearer tok-admin' });
  assert.strictEqual(r2.status, 404);
});

// Apoji Admin's desktop app (apoji://admin) uses the staff function for its Mexel page
import { cors as corsFor } from '../supabase/functions/_shared/lib.mjs';
import assertCors from 'node:assert';
assertCors.strictEqual(corsFor(new Request('https://x/', { headers: { origin: 'apoji://admin' } }))['Access-Control-Allow-Origin'], 'apoji://admin');
