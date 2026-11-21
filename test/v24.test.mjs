// aARgon3 2.4: tax by region, gifts, referral codes, the customer portal (plan changes, pausing, cancelling), abandoned-checkout
// reminders, emailed receipts, quote alerts, store hours and closures. Same fakes as functions.test.mjs.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { handler as checkout } from '../supabase/functions/checkout/handler.mjs';
import { handler as webhook } from '../supabase/functions/stripe-webhook/handler.mjs';
import { handler as staff } from '../supabase/functions/staff/handler.mjs';
import { storeStatus, cleanHours, giftPrice, A3 } from '../supabase/functions/_shared/lib.mjs';
import { ENV, world, OWNER, MANAGER, EMPLOYEE } from './fakes.mjs';

const req = (body, headers = {}) => new Request('https://fn.test/', { method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'https://apojidelegraphics.github.io', 'x-forwarded-for': '9.9.9.9', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const call = async (h, body, headers) => { const r = await h(req(body, headers)); return { status: r.status, body: await r.json().catch(() => null) }; };
const as = tok => ({ authorization: `Bearer ${tok}` });
const PAT = { first: 'Pat', last: 'Doe', email: 'pat@co.com', phone: '919-555-0100', company: 'Doe Labs LLC', title: 'Owner' };
const signed = (body, t = Math.floor(Date.now() / 1000)) => ({ 'stripe-signature': `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex')}` });
const pay = s => { s.status = 'complete'; s.payment_status = 'paid'; };
const event = (h, type, object) => { const b = JSON.stringify({ type, data: { object } }); return call(h, b, signed(b)); };
// a paid store order, written by the webhook
async function buy(w, body) {
  const store = checkout(ENV, w.fetch), hook = webhook(ENV, w.fetch);
  const r = await call(store, { action: 'start', plan: 'personal', tier: 'pro', billing: 'month', customer: PAT, ...body });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const s = Object.values(w.sessions).pop(); pay(s);
  await event(hook, 'checkout.session.completed', s);
  return { s, order: w.orders[s.metadata.a3_order] };
}

test('tax by region: the owner sets rates, checkout and invoices charge them, a changed rate retires the old one', async () => {
  const w = world(), h = staff(ENV, w.fetch), store = checkout(ENV, w.fetch);
  assert.match((await call(h, { action: 'settings_save', key: 'tax', value: { enabled: true, regions: { B: { rate: 7 } } } }, as(MANAGER))).body.error, /owner/);
  const r = await call(h, { action: 'settings_save', key: 'tax', value: { enabled: true, label: 'Sales tax', regions: { B: { rate: 7 }, E: { rate: 4.75 } } } }, as(OWNER));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const t1 = w.settings.tax.regions.B.stripe_id; assert.ok(t1 && w.settings.tax.regions.E.stripe_id); assert.strictEqual(w.settings.tax.regions.A, undefined);
  // the store shows rates (no Stripe ids) for an estimate
  const info = (await call(store, { action: 'info' })).body; assert.deepStrictEqual(info.tax, { label: 'Sales tax', rates: { B: 7, E: 4.75 } });
  // region B checkout: the line item carries the tax rate; the order keeps the region and the tax
  const { s, order } = await buy(w, { region: 'B' });
  assert.strictEqual(s.form.get('line_items[0][tax_rates][0]'), t1);
  assert.strictEqual(order.region, 'B'); assert.strictEqual(order.tax_cents, 175);   // 7% of $25
  // no region (or a 0% region): no tax
  const { s: s2 } = await buy(w, { region: 'A' }); assert.strictEqual(s2.form.get('line_items[0][tax_rates][0]'), null);
  // same rate again: same Stripe rate; a new rate: new Stripe rate, old one archived; 0: archived
  await call(h, { action: 'settings_save', key: 'tax', value: { enabled: true, label: 'Sales tax', regions: { B: { rate: 7 }, E: { rate: 4.75 } } } }, as(OWNER));
  assert.strictEqual(w.settings.tax.regions.B.stripe_id, t1); assert.deepStrictEqual(w.archivedTax, []);
  await call(h, { action: 'settings_save', key: 'tax', value: { enabled: true, label: 'Sales tax', regions: { B: { rate: 7.5 } } } }, as(OWNER));
  assert.notStrictEqual(w.settings.tax.regions.B.stripe_id, t1); assert.strictEqual(w.archivedTax.length, 2);   // old B + E switched off
  // terminal sale at a region-B store picks up B's rate
  await call(h, { action: 'me' }, as(EMPLOYEE)); await call(h, { action: 'clock_in', store: '0427' }, as(EMPLOYEE));
  await call(h, { action: 'sale', plan: 'personal', tier: 'plus', billing: 'month', customer: PAT }, as(EMPLOYEE));
  assert.strictEqual(Object.values(w.sessions).pop().form.get('line_items[0][tax_rates][0]'), w.settings.tax.regions.B.stripe_id);
  // invoices too (one-time custom order sent as an invoice)
  await call(h, { action: 'quote_save', plan: 'business', tier: 'pro', seats: 9, interval: 'once', amount: 999, customer: PAT }, as(MANAGER));
  const q = Object.values(w.quotes).pop();
  await call(h, { action: 'quote_send', quote_no: q.quote_no, delivery: 'invoice', region: 'B' }, as(MANAGER));
  const ii = w.calls.filter(c => c.url.endsWith('/invoiceitems')).pop();
  assert.strictEqual(new URLSearchParams(ii.body).get('tax_rates[0]'), w.settings.tax.regions.B.stripe_id);
});

test('gifts: paid once for 1/3/6/12 months, hidden until claimed with the code, emailed to the person it is for', async () => {
  assert.strictEqual(giftPrice(A3.selection({ plan: 'personal', tier: 'plus', billing: 'month' }), 3).cents, 3600);
  assert.strictEqual(giftPrice(A3.selection({ plan: 'personal', tier: 'plus', billing: 'month' }), 12).cents, 12000);   // 12 months = the yearly price
  const w = world(), store = checkout(ENV, w.fetch);
  w.settings.email = { message_template: 'template_msg' };
  assert.match((await call(store, { action: 'start', plan: 'personal', tier: 'plus', customer: PAT, gift: { months: 2, to_name: 'Ari' } })).body.error, /1, 3, 6 or 12/);
  assert.match((await call(store, { action: 'start', plan: 'personal', tier: 'plus', customer: PAT, gift: { months: 3 } })).body.error, /Who's the gift for/);
  const { s, order } = await buy(w, { tier: 'plus', gift: { months: 3, to_name: 'Ari', to_email: 'ari@x.co', message: 'Happy birthday!' } });
  assert.strictEqual(s.mode, 'payment'); assert.strictEqual(s.form.get('line_items[0][price_data][unit_amount]'), '3600');
  assert.match(s.form.get('line_items[0][price_data][product_data][name]'), /^Gift: Personal Plus for 3 months/);
  assert.strictEqual(order.status, 'GIFT'); assert.match(order.gift_code, /^GIFT-[A-Z0-9]{4}-[A-Z0-9]{4}$/); assert.strictEqual(order.billing, 'once');
  // the email goes to Ari, with the claim link
  const mail = w.emails.pop();
  assert.strictEqual(mail.template_id, 'template_msg'); assert.strictEqual(mail.template_params.to_email, 'ari@x.co');
  assert.match(mail.template_params.button_url, new RegExp(`account\\.html\\?gift=${order.gift_code}`)); assert.match(mail.template_params.message, /Happy birthday/);
  // the thank-you page shows the code to the buyer
  const st = (await call(store, { action: 'status', session_id: s.id })).body;
  assert.strictEqual(st.order.gift.code, order.gift_code);
  // not in the portal until claimed; claim once
  assert.strictEqual((await call(store, { action: 'portal', order: order.order_id, email: 'pat@co.com' })).status, 404);
  assert.strictEqual((await call(store, { action: 'gift_check', code: order.gift_code.toLowerCase() })).body.gift.months, 3);
  const c = await call(store, { action: 'gift_claim', code: order.gift_code, customer: { first: 'Ari', last: 'Lane', email: 'Ari@x.co', phone: '' } });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body)); assert.strictEqual(c.body.order.order_id, order.order_id);
  assert.strictEqual(order.status, 'ACTIVE'); assert.ok(new Date(order.expires_at) > new Date(Date.now() + 80 * 864e5));
  assert.match((await call(store, { action: 'gift_claim', code: order.gift_code, customer: { first: 'Z', last: 'Z', email: 'z@z.co' } })).body.error, /already been claimed/);
  assert.strictEqual((await call(store, { action: 'portal', order: order.order_id, email: 'ari@x.co' })).status, 200);
  // no recipient email: the code goes to the buyer instead
  const { order: o2 } = await buy(w, { gift: { months: 1, to_name: 'Kai' } });
  assert.strictEqual(w.emails.pop().template_params.to_email, 'pat@co.com'); assert.strictEqual(o2.status, 'GIFT');
  // referral codes don't stack on gifts
  assert.match((await call(store, { action: 'start', plan: 'personal', tier: 'pro', customer: { ...PAT, email: 'new@x.co' }, gift: { months: 1, to_name: 'K' }, promo: order.referral_code || 'REF-ZZZZZZ' })).body.error, /./);
});

test('referral codes: a month off for the new customer, a month of credit for the person who shared it, never your own', async () => {
  const w = world(), store = checkout(ENV, w.fetch), hook = webhook(ENV, w.fetch);
  const { order: kim } = await buy(w, { plan: 'business', tier: 'pro', customer: { ...PAT, email: 'kim@co.com' } });
  assert.match(kim.referral_code, /^REF-[A-Z0-9]{6}$/);
  // the "Apply" button
  const ap = await call(store, { action: 'promo', code: kim.referral_code.toLowerCase(), plan: 'personal', tier: 'pro', billing: 'month' });
  assert.strictEqual(ap.status, 200, JSON.stringify(ap.body)); assert.match(ap.body.label, /1 month off \(\$25(\.00)?\)/); assert.strictEqual(ap.body.after, 0);
  assert.match((await call(store, { action: 'start', plan: 'personal', tier: 'pro', customer: { ...PAT, email: 'KIM@co.com' }, promo: kim.referral_code })).body.error, /your own referral code/);
  assert.match((await call(store, { action: 'promo', code: 'REF-NOPE00', plan: 'personal', tier: 'pro', billing: 'month' })).body.error, /isn't a working code/);
  // a friend buys Personal Pro yearly with Kim's code: one-time coupon worth one month
  const { s, order } = await buy(w, { billing: 'year', customer: { ...PAT, email: 'friend@x.co' }, promo: kim.referral_code });
  const coupon = w.calls.filter(c => c.url.endsWith('/coupons')).pop(); const cf = new URLSearchParams(coupon.body);
  assert.strictEqual(cf.get('amount_off'), '2500'); assert.strictEqual(cf.get('duration'), 'once'); assert.strictEqual(cf.get('max_redemptions'), '1');
  assert.ok(s.form.get('discounts[0][coupon]')); assert.strictEqual(s.metadata.a3_ref, kim.referral_code); assert.strictEqual(s.metadata.a3_promo, undefined);
  assert.strictEqual(order.referred_by, kim.referral_code);
  // Kim gets a month of Business Pro ($149) as account credit
  assert.deepStrictEqual(w.credits.map(c => [c.customer, c.amount]), [[kim.stripe_customer_id, -14900]]);
  assert.deepStrictEqual(w.referrals.map(r => [r.referrer_order, r.new_order, r.status]), [[kim.order_id, order.order_id, 'credited']]);
  // the webhook firing twice doesn't pay twice
  await event(hook, 'checkout.session.completed', s); assert.strictEqual(w.credits.length, 1);
  // yearly limit
  w.settings.referral = { enabled: true, max_per_year: 1 };
  const { order: o3 } = await buy(w, { customer: { ...PAT, email: 'third@x.co' }, promo: kim.referral_code });
  assert.strictEqual(w.credits.length, 1); assert.strictEqual(w.referrals.find(r => r.new_order === o3.order_id).status, 'limit');
  // switched off
  w.settings.referral = { enabled: false };
  assert.match((await call(store, { action: 'promo', code: kim.referral_code, plan: 'personal', tier: 'pro', billing: 'month' })).body.error, /switched off/);
});

test('customer portal: number + email, slows down guessing, shows plan, renewal and invoices', async () => {
  const w = world(), store = checkout(ENV, w.fetch);
  const { order } = await buy(w, {});
  w.invoiceList = [{ number: 'A3-0001', created: 1790000000, amount_paid: 2500, tax: 0, status: 'paid', hosted_invoice_url: 'https://invoice.stripe.com/i/1', invoice_pdf: 'https://pay.stripe.com/pdf/1', billing_reason: 'subscription_create' }];
  const r = await call(store, { action: 'portal', order: order.order_id.toLowerCase(), email: ' PAT@co.com ' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.order.plan, 'Personal'); assert.ok(r.body.order.current_period_end); assert.strictEqual(r.body.order.price, 25);
  assert.match(r.body.order.referral_code, /^REF-/); assert.deepStrictEqual(r.body.order.can, { change: true, pause: true, resume: false, cancel: true, keep: false, card: true });
  assert.strictEqual(r.body.invoices[0].url, 'https://invoice.stripe.com/i/1');
  for (const k of ['operator', 'staff_user_id', 'customer_info', 'history', 'notes']) assert.ok(!(k in r.body.order), k);
  // wrong email: 404, counted; ten wrong and that IP waits
  for (let i = 0; i < 10; i++) assert.strictEqual((await call(store, { action: 'portal', order: order.order_id, email: 'x@y.co' })).status, 404);
  assert.strictEqual((await call(store, { action: 'portal', order: order.order_id, email: 'pat@co.com' })).status, 429);
  assert.strictEqual((await call(store, { action: 'portal', order: order.order_id, email: 'pat@co.com' }, { 'x-forwarded-for': '8.8.8.8' })).status, 429);   // and that order number
});

test('portal: upgrade charges the difference now, downgrade becomes credit, pause 1–3 months, cancel at the end (and undo)', async () => {
  const w = world(), store = checkout(ENV, w.fetch), H = { 'x-forwarded-for': '7.7.7.7' };
  const { order } = await buy(w, {});
  const me = { order: order.order_id, email: 'pat@co.com' };
  // upgrade Pro → Max ($25 → $59), halfway through the month: pay half the difference now
  const pv = await call(store, { action: 'portal_change', ...me, plan: 'personal', tier: 'max', billing: 'month' }, H);
  assert.strictEqual(pv.status, 200, JSON.stringify(pv.body)); assert.strictEqual(pv.body.upgrade, true); assert.strictEqual(pv.body.due_now, 17); assert.strictEqual(pv.body.credit, 0);
  assert.strictEqual(w.subUpdates.length, 0);   // a preview changes nothing
  const ap = await call(store, { action: 'portal_change', ...me, plan: 'personal', tier: 'max', billing: 'month', apply: true }, H);
  assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
  const up = w.subUpdates.pop().form;
  assert.strictEqual(up.get('proration_behavior'), 'always_invoice'); assert.strictEqual(up.get('items[0][price_data][unit_amount]'), '5900'); assert.strictEqual(up.get('payment_behavior'), 'error_if_incomplete');
  assert.strictEqual(order.tier, 'max'); assert.strictEqual(order.amount_cents, 5900); assert.ok(order.items.some(i => i.model === 'Neodela'));
  assert.strictEqual(order.history.at(-1).kind, 'change');
  // downgrade Max → Plus: credit, nothing charged now
  const dn = await call(store, { action: 'portal_change', ...me, plan: 'personal', tier: 'plus', billing: 'month' }, H);
  assert.strictEqual(dn.body.upgrade, false); assert.strictEqual(dn.body.due_now, 0); assert.strictEqual(dn.body.credit, 23.5);   // half of ($59 − $12)
  assert.match((await call(store, { action: 'portal_change', ...me, plan: 'personal', tier: 'max', billing: 'month' }, H)).body.error, /already have/);
  assert.match((await call(store, { action: 'portal_change', ...me, plan: 'enterprise', tier: 'max', billing: 'month' }, H)).body.error, /Enterprise/);
  // pause 2 months, then resume
  assert.match((await call(store, { action: 'portal_pause', ...me, months: 6 }, H)).body.error, /1, 2 or 3/);
  const pz = await call(store, { action: 'portal_pause', ...me, months: 2 }, H);
  assert.strictEqual(pz.status, 200, JSON.stringify(pz.body)); assert.strictEqual(order.status, 'PAUSED'); assert.strictEqual(pz.body.order.can.resume, true);
  assert.strictEqual(w.subUpdates.pop().form.get('pause_collection[behavior]'), 'void');
  await call(store, { action: 'portal_resume', ...me }, H);
  const rs = w.subUpdates.pop().form; assert.ok(rs.has('pause_collection') && rs.get('pause_collection') === ''); assert.strictEqual(order.status, 'ACTIVE');
  // cancel at the period end; keep
  const cx = await call(store, { action: 'portal_cancel', ...me }, H);
  assert.strictEqual(w.subUpdates.pop().form.get('cancel_at_period_end'), 'true'); assert.ok(order.cancel_at); assert.strictEqual(cx.body.order.can.keep, true); assert.strictEqual(cx.body.order.can.change, false);
  await call(store, { action: 'portal_keep', ...me }, H);
  assert.strictEqual(w.subUpdates.pop().form.get('cancel_at_period_end'), 'false'); assert.strictEqual(order.cancel_at, null);
  // update card: Stripe's billing portal (with a clear message if it isn't switched on)
  assert.match((await call(store, { action: 'portal_card', ...me }, H)).body.url, /billing\.stripe\.com/);
  w.noPortal = true; assert.match((await call(store, { action: 'portal_card', ...me }, H)).body.error, /Customer portal/);
});

test('staff: managers change, pause and cancel-at-end orders; employees cannot; everyone can email a receipt with the store name', async () => {
  const w = world(), h = staff(ENV, w.fetch);
  const { order } = await buy(w, { region: 'B' });
  assert.strictEqual((await call(h, { action: 'order_change', order_id: order.order_id, plan: 'personal', tier: 'max', billing: 'month' }, as(EMPLOYEE))).status, 403);
  assert.strictEqual((await call(h, { action: 'order_change', order_id: order.order_id, plan: 'personal', tier: 'max', billing: 'month', apply: true }, as(MANAGER))).status, 200);
  assert.strictEqual(order.history.at(-1).by, 'Riley'); assert.ok(w.logs.some(l => l.p_action === 'plan_change'));
  assert.strictEqual((await call(h, { action: 'order_pause', order_id: order.order_id, months: 1 }, as(MANAGER))).status, 200);
  const view = (await call(h, { action: 'order', order_id: order.order_id }, as(MANAGER))).body;
  assert.strictEqual(view.can.resume, true); assert.ok(view.paused_until);
  assert.deepStrictEqual((await call(h, { action: 'order', order_id: order.order_id }, as(EMPLOYEE))).body.can, { card: false });
  // receipts: the old EmailJS template's fields, plus the store's name
  await call(h, { action: 'me' }, as(EMPLOYEE)); await call(h, { action: 'clock_in', store: '0427' }, as(EMPLOYEE));
  const r = await call(h, { action: 'receipt_email', order_id: order.order_id }, as(EMPLOYEE));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const m = w.emails.pop();
  assert.deepStrictEqual([m.service_id, m.template_id, m.user_id], ['service_xebrht3', 'template_3lwqybm', 'GYO37b2vvZjIJiMFC']);
  const p = m.template_params;
  for (const k of ['to_email', 'email', 'order_id', 'customer_name', 'node_id', 'jurisdiction', 'items_text', 'config_text', 'shipping_cost', 'tax_cost', 'total_cost', 'currency']) assert.ok(k in p, k);
  assert.strictEqual(p.to_email, 'pat@co.com'); assert.match(p.config_text, /^Store: Apoji Delegraphics · Store #0427/); assert.match(p.store_name, /Raleigh-Durham/);
  assert.strictEqual((await call(h, { action: 'receipt_email', order_id: order.order_id, to: 'not-an-email' }, as(EMPLOYEE))).status, 400);
  w.emailFail = 'The Public Key is invalid';
  assert.match((await call(h, { action: 'receipt_email', order_id: order.order_id }, as(EMPLOYEE))).body.error, /EmailJS: The Public Key is invalid/);
  w.emailFail = null; w.settings.email = { enabled: false };
  assert.match((await call(h, { action: 'receipt_email', order_id: order.order_id }, as(EMPLOYEE))).body.error, /switched off/);
  // owner: test both templates (no message template yet → says so)
  w.settings.email = {};
  const t = (await call(h, { action: 'email_test' }, as(OWNER))).body;
  assert.strictEqual(t.receipt, 'sent'); assert.match(t.message, /No email template/);
});

test('abandoned checkout: one reminder, only if they asked for it, not if they bought anyway', async () => {
  const w = world(), store = checkout(ENV, w.fetch), hook = webhook(ENV, w.fetch);
  w.settings.email = { message_template: 'template_msg' };
  await call(store, { action: 'start', plan: 'business', tier: 'pro', billing: 'month', customer: { ...PAT, email: 'lee@x.co' }, followup: true });
  const s = Object.values(w.sessions).pop();
  assert.strictEqual(s.metadata.a3_followup, '1'); assert.ok(s.expires_at > Date.now() / 1000 + 2.9 * 3600 && s.expires_at < Date.now() / 1000 + 3.1 * 3600);
  const r = await event(hook, 'checkout.session.expired', s);
  assert.strictEqual(r.body.reminded, true, JSON.stringify(r.body));
  const m = w.emails.pop(); assert.strictEqual(m.template_params.to_email, 'lee@x.co'); assert.match(m.template_params.button_url, /\?plan=business&tier=pro&billing=month#plans$/);
  assert.ok(w.abandoned[0].emailed_at);
  assert.strictEqual((await event(hook, 'checkout.session.expired', s)).body.ignored, 'seen'); assert.strictEqual(w.emails.length, 0);
  // didn't tick the box: nothing
  await call(store, { action: 'start', plan: 'personal', tier: 'pro', customer: { ...PAT, email: 'no@x.co' } });
  assert.match((await event(hook, 'checkout.session.expired', Object.values(w.sessions).pop())).body.ignored, /no reminder/);
  // bought something with the same email: nothing
  await buy(w, { customer: { ...PAT, email: 'back@x.co' } });
  await call(store, { action: 'start', plan: 'personal', tier: 'max', customer: { ...PAT, email: 'back@x.co' }, followup: true });
  assert.strictEqual((await event(hook, 'checkout.session.expired', Object.values(w.sessions).pop())).body.ignored, 'already bought');
  // staff sale links never get reminders, and they keep Stripe's 24 hours
  const h = staff(ENV, w.fetch); await call(h, { action: 'me' }, as(OWNER));
  await call(h, { action: 'sale', plan: 'personal', tier: 'pro', billing: 'month', customer: PAT, followup: true }, as(OWNER));
  const ss = Object.values(w.sessions).pop(); assert.strictEqual(ss.metadata.a3_followup, undefined); assert.strictEqual(ss.expires_at, null);
  // no message template: saved with the error, so staff can see it
  w.settings.email = {};
  await call(store, { action: 'start', plan: 'personal', tier: 'pro', customer: { ...PAT, email: 'late@x.co' }, followup: true });
  const r2 = await event(hook, 'checkout.session.expired', Object.values(w.sessions).pop());
  assert.match(r2.body.error, /No email template/); assert.match(w.abandoned.find(a => a.email === 'late@x.co').email_error, /No email template/);
  assert.strictEqual((await call(h, { action: 'abandoned' }, as(MANAGER))).body.length, 2);
});

test('alerts: custom orders and Enterprise quotes waiting more than N days show up for managers', async () => {
  const w = world(), h = staff(ENV, w.fetch);
  const old = d => new Date(Date.now() - d * 864e5).toISOString();
  Object.assign(w.quotes, { 'Q-OLD001': { quote_no: 'Q-OLD001', status: 'sent', plan: 'enterprise', tier: 'max', customer: { company: 'Globex' }, created_at: old(5) },
    'Q-OLD002': { quote_no: 'Q-OLD002', status: 'requested', plan: 'business', tier: 'pro', customer: { company: 'Initech' }, created_at: old(4) },
    'Q-NEW003': { quote_no: 'Q-NEW003', status: 'draft', plan: 'enterprise', tier: 'pro', customer: {}, created_at: old(1) },
    'Q-PAID04': { quote_no: 'Q-PAID04', status: 'paid', plan: 'enterprise', tier: 'pro', customer: {}, created_at: old(9) } });
  const me = (await call(h, { action: 'me' }, as(MANAGER))).body;
  assert.deepStrictEqual(me.alerts.map(a => [a.quote_no, a.days]), [['Q-OLD001', 5], ['Q-OLD002', 4]]);   // Enterprise first
  assert.strictEqual(me.requests, 1); assert.strictEqual(me.alert_days, 3);
  assert.deepStrictEqual((await call(h, { action: 'me' }, as(EMPLOYEE))).body.alerts, []);
  await call(h, { action: 'settings_save', key: 'alerts', value: { quote_days: 5 } }, as(OWNER));
  assert.deepStrictEqual((await call(h, { action: 'me' }, as(MANAGER))).body.alerts.map(a => a.quote_no), ['Q-OLD001']);
});

test('store hours and closures: per-store hours, closed days, and online closures that close checkout', async () => {
  assert.throws(() => cleanHours({ mon: ['21:00', '09:00'] }), /opening has to be before closing/);
  const hours = cleanHours({ mon: ['09:00', '21:00'], tue: ['09:00', '21:00'], wed: ['09:00', '21:00'], thu: ['09:00', '21:00'], fri: ['09:00', '22:00'], sat: ['10:00', '18:00'], sun: null });
  const st = { code: '0028', hours };
  const at = (d, t) => new Date(`${d}T${t}:00-05:00`).getTime();   // Eastern
  assert.deepStrictEqual(storeStatus(st, [], at('2026-11-23', '10:30')), { open: true, label: '09:00–21:00', opens: '09:00', closes: '21:00' });   // Monday
  assert.strictEqual(storeStatus(st, [], at('2026-11-23', '21:30')).open, false);
  assert.deepStrictEqual(storeStatus(st, [], at('2026-11-22', '12:00')), { open: false, label: 'Closed today' });   // Sunday
  assert.strictEqual(storeStatus(st, [{ store_code: '0028', starts_on: '2026-11-26', ends_on: '2026-11-26', reason: 'Thanksgiving' }], at('2026-11-26', '12:00')).reason, 'Thanksgiving');
  assert.strictEqual(storeStatus({ code: 'x', hours: null }).open, null);
  const w = world(), h = staff(ENV, w.fetch), store = checkout(ENV, w.fetch);
  assert.strictEqual((await call(h, { action: 'store_hours', code: '0028', hours }, as(MANAGER))).status, 403);
  assert.strictEqual((await call(h, { action: 'store_hours', code: '0028', hours }, as(OWNER))).status, 200);
  assert.strictEqual((await call(h, { action: 'closure_save', starts_on: '2026-12-25', reason: 'Christmas', store_code: '0028' }, as(EMPLOYEE))).status, 403);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  assert.strictEqual((await call(h, { action: 'closure_save', starts_on: today, ends_on: today, reason: 'inventory day' }, as(MANAGER))).status, 200);
  // the online store is closed today: info says so, checkout refuses
  const info = (await call(store, { action: 'info' })).body;
  assert.strictEqual(info.open, false); assert.match(info.message, /closed for inventory day/);
  assert.strictEqual((await call(store, { action: 'start', plan: 'personal', tier: 'pro', customer: PAT })).status, 409);
  // the Stores page and the terminal know each store's hours
  const pub = (await call(store, { action: 'stores' })).body; assert.deepStrictEqual(pub.stores.find(x => x.code === '0028').hours.sun, null);
  const me = (await call(h, { action: 'me' }, as(EMPLOYEE))).body; assert.ok(me.hours.stores.find(x => x.code === '0028').now.label);
  assert.strictEqual(me.store.open, false);
  await call(h, { action: 'closure_delete', id: w.closures[0].id }, as(MANAGER));
  assert.strictEqual((await call(store, { action: 'info' })).body.open, true);
});
