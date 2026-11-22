// aARgon3 2.5: deals, the "find a code" panel, old codes brought into Stripe, generated code batches, a fuller customer portal.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { handler as checkout } from '../supabase/functions/checkout/handler.mjs';
import { handler as webhook } from '../supabase/functions/stripe-webhook/handler.mjs';
import { handler as staff } from '../supabase/functions/staff/handler.mjs';
import { applyDeals, A3 } from '../supabase/functions/_shared/lib.mjs';
import { ENV, world, OWNER, MANAGER, EMPLOYEE } from './fakes.mjs';

const req = (body, headers = {}) => new Request('https://fn.test/', { method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'https://apojidelegraphics.github.io', 'x-forwarded-for': '5.5.5.5', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const call = async (h, body, headers) => { const r = await h(req(body, headers)); return { status: r.status, body: await r.json().catch(() => null) }; };
const as = tok => ({ authorization: `Bearer ${tok}` });
const PAT = { first: 'Pat', last: 'Doe', email: 'pat@co.com', phone: '919-555-0100', company: 'Doe Labs LLC', title: 'Owner' };
const signed = (body, t = Math.floor(Date.now() / 1000)) => ({ 'stripe-signature': `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex')}` });
const pay = s => { s.status = 'complete'; s.payment_status = 'paid'; };
async function buy(w, body) {
  const store = checkout(ENV, w.fetch), hook = webhook(ENV, w.fetch);
  const r = await call(store, { action: 'start', plan: 'personal', tier: 'plus', billing: 'month', customer: PAT, ...body });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const s = Object.values(w.sessions).pop(); pay(s);
  const b = JSON.stringify({ type: 'checkout.session.completed', data: { object: s } }); await call(hook, b, signed(b));
  return { s, order: w.orders[s.metadata.a3_order] };
}
const later = d => new Date(Date.now() + d * 864e5).toISOString();

test('deals: managers make them; checkout applies the best price deal (unless a code is used) and every perk', async () => {
  const w = world(), h = staff(ENV, w.fetch), store = checkout(ENV, w.fetch);
  assert.strictEqual((await call(h, { action: 'deal_save', kind: 'percent', value: 20, headline: 'x' }, as(EMPLOYEE))).status, 403);
  assert.match((await call(h, { action: 'deal_save', kind: 'models', headline: 'Bonus', models: [] }, as(MANAGER))).body.error, /bonus model/);
  const pct = await call(h, { action: 'deal_save', kind: 'percent', value: 20, duration: 'repeating', duration_months: 3, headline: 'Plus is 20% off for 3 months', tiers: ['plus'], ends_at: later(7) }, as(MANAGER));
  assert.strictEqual(pct.status, 200, JSON.stringify(pct.body));
  const coupon = new URLSearchParams(w.calls.filter(c => c.url.endsWith('/coupons')).pop().body);
  assert.strictEqual(coupon.get('percent_off'), '20'); assert.strictEqual(coupon.get('duration_in_months'), '3');
  await call(h, { action: 'deal_save', kind: 'amount', value: 2, headline: '$2 off any Personal plan', plans: ['personal'] }, as(MANAGER));
  await call(h, { action: 'deal_save', kind: 'models', models: ['Neodela', 'Denali'], headline: '2 for 1: Neodela and Denali free with Plus', tiers: ['plus'] }, as(MANAGER));
  await call(h, { action: 'deal_save', kind: 'chip', chip: 'Quouk .2o', headline: 'Free chip upgrade', billing: ['year'] }, as(MANAGER));
  await call(h, { action: 'deal_save', kind: 'seats', value: 2, headline: '2 extra people on Business', plans: ['business'] }, as(MANAGER));
  await call(h, { action: 'deal_save', kind: 'percent', value: 90, headline: 'Over', ends_at: later(-1) }, as(MANAGER));   // already over
  // the store page sees the live deals (no Stripe ids)
  const info = (await call(store, { action: 'info' })).body;
  assert.strictEqual(info.deals.length, 5); assert.ok(info.deals.every(d => !('stripe_coupon_id' in d)));
  assert.strictEqual(info.deals.find(d => d.kind === 'models').label, 'Neodela, Denali included free');
  // Personal Plus monthly: best price deal is 20% ($2.40 > $2), plus the bonus models
  const { s, order } = await buy(w, {});
  assert.ok(s.form.get('discounts[0][coupon]')); assert.strictEqual(s.metadata.a3_bonus, 'Neodela,Denali');
  assert.ok(order.items.some(i => i.model === 'Neodela' && i.deal)); assert.ok(order.items.some(i => i.model === 'Denali'));
  assert.deepStrictEqual(order.deals.map(d => d.kind).sort(), ['models', 'percent']);
  assert.strictEqual(w.deals.find(d => d.kind === 'percent' && d.value === 20).used_count, 1);
  assert.match(s.form.get('line_items[0][price_data][product_data][description]'), /Deals: Plus is 20% off/);
  // with a code: no price deal (one discount per order), perks still apply
  await call(h, { action: 'promo_save', code: 'SAVE5', type: 'fixed', value: 5 }, as(MANAGER));
  const { s: s2 } = await buy(w, { promo: 'SAVE5' });
  assert.ok(s2.form.get('discounts[0][promotion_code]')); assert.strictEqual(s2.form.get('discounts[0][coupon]'), null); assert.strictEqual(s2.metadata.a3_bonus, 'Neodela,Denali');
  // yearly gets the chip; Business gets extra people
  const { order: y } = await buy(w, { tier: 'pro', billing: 'year' }); assert.strictEqual(y.config.chip, 'Quouk .2o');
  const { order: biz } = await buy(w, { plan: 'business', tier: 'pro', billing: 'month' }); assert.strictEqual(biz.seats, A3.price('business', 'pro', 'month').seats + 2);
  // gifts don't get deals
  const { s: g } = await buy(w, { gift: { months: 1, to_name: 'Ari' } }); assert.strictEqual(g.metadata.a3_deals, undefined);
  // switch one off
  const d = w.deals.find(x => x.kind === 'models');
  await call(h, { action: 'deal_save', id: d.id, active: false }, as(MANAGER));
  const { s: s3 } = await buy(w, {}); assert.strictEqual(s3.metadata.a3_bonus, undefined);
  // terminal sales get deals too
  await call(h, { action: 'me' }, as(OWNER));
  await call(h, { action: 'sale', plan: 'personal', tier: 'plus', billing: 'month', customer: PAT }, as(OWNER));
  assert.ok(Object.values(w.sessions).pop().form.get('discounts[0][coupon]'));
});

test('applyDeals: picks the bigger saving and skips bonus models the tier already has', () => {
  const sel = A3.selection({ plan: 'business', tier: 'max', billing: 'month' });   // $299
  const deals = [{ id: 1, kind: 'percent', value: 10, stripe_coupon_id: 'a' }, { id: 2, kind: 'amount', value: 40, stripe_coupon_id: 'b' }, { id: 3, kind: 'models', models: ['Neodela', 'Lyte-28'] }];
  const r = applyDeals(deals, sel);
  assert.strictEqual(r.price.id, 2); assert.strictEqual(r.saving, 40); assert.strictEqual(r.after, 259);
  assert.deepStrictEqual(r.models, []);   // Max already includes both
  assert.strictEqual(applyDeals(deals, sel, { promo: { code: 'X' } }).price, null);
});

test('find a code: the sale page lists codes that fit (best first), the ones that almost do, and the automatic deals', async () => {
  const w = world(), h = staff(ENV, w.fetch);
  await call(h, { action: 'promo_save', code: 'PLUS10', type: 'percentage', value: 10, tiers: ['plus'] }, as(MANAGER));
  await call(h, { action: 'promo_save', code: 'BIZ25', type: 'percentage', value: 25, plans: ['business'] }, as(MANAGER));
  await call(h, { action: 'promo_save', code: 'TAKE3', type: 'fixed', value: 3 }, as(MANAGER));
  await call(h, { action: 'promo_save', code: 'BIGSPEND', type: 'fixed', value: 10, min_total: 50 }, as(MANAGER));
  await call(h, { action: 'deal_save', kind: 'models', models: ['Neodela'], headline: 'Neodela free', tiers: ['plus'] }, as(MANAGER));
  const r = await call(h, { action: 'promo_list', plan: 'personal', tier: 'plus', billing: 'month' }, as(EMPLOYEE));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.codes.map(c => [c.code, c.fits]), [['TAKE3', true], ['PLUS10', true], ['BIGSPEND', false], ['BIZ25', false]]);
  assert.strictEqual(r.body.codes.find(c => c.code === 'BIZ25').why, 'Business only'); assert.strictEqual(r.body.codes.find(c => c.code === 'BIGSPEND').why, 'needs $50+');
  assert.deepStrictEqual(r.body.models, ['Neodela']); assert.strictEqual(r.body.deals[0].headline, 'Neodela free');
});

test('old codes: tidied, given a Stripe coupon + promotion code, expired ones switched off', async () => {
  const w = world(), h = staff(ENV, w.fetch);
  const old = (id, x) => ({ id, used: 0, active: true, live: true, old: true, stripe_promo_id: null, duration: 'once', ...x });
  w.promos.push(old(1, { code: 'fall fun', type: 'percentage', value: 15, plans: ['Personal', 'Pro'], tiers: null }),
    old(2, { code: 'SUMMER25', type: 'percentage', value: 25, ends: later(-30) }),
    old(3, { code: 'BIGOFF', type: 'fixed', value: 10, limit: 5, used: 2, ends: later(10) }),
    old(4, { code: 'WELCOME', type: 'percentage', value: 5 }),
    old(5, { code: 'BROKEN', type: 'percentage', value: 0 }));
  w.promoCodesStripe.push('WELCOME');   // made by hand in Stripe once
  assert.strictEqual((await call(h, { action: 'promo_upgrade' }, as(EMPLOYEE))).status, 403);
  const r = await call(h, { action: 'promo_upgrade' }, as(MANAGER));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const by = Object.fromEntries(r.body.map(x => [x.from, x]));
  assert.strictEqual(by['fall fun'].code, 'FALL-FUN'); assert.match(by['fall fun'].result, /renamed/); assert.ok(by['fall fun'].live);
  assert.deepStrictEqual([w.promos[0].plans, w.promos[0].tiers], [['personal'], ['pro']]);   // "Pro" was a tier
  assert.match(by.SUMMER25.result, /already expired/); assert.strictEqual(w.promos[1].live, false); assert.strictEqual(w.promos[1].ended_reason, 'expired');
  const big = w.calls.filter(c => c.url.endsWith('/promotion_codes')).map(c => new URLSearchParams(c.body)).find(f => f.get('code') === 'BIGOFF');
  assert.strictEqual(big.get('max_redemptions'), '3'); assert.ok(big.get('expires_at'));
  assert.strictEqual(by.WELCOME.result, 'works now'); assert.strictEqual(w.promos[3].stripe_promo_id, 'promo_WELCOME');   // linked to the one already in Stripe
  assert.match(by.BROKEN.result, /not valid/);
  // the new system takes them now
  const store = checkout(ENV, w.fetch);
  assert.strictEqual((await call(store, { action: 'promo', code: 'fall-fun', plan: 'personal', tier: 'pro', billing: 'month' })).status, 200);
  assert.strictEqual((await call(store, { action: 'promo', code: 'SUMMER25', plan: 'personal', tier: 'pro', billing: 'month' })).status, 400);
  // nothing left to do the second time
  assert.deepStrictEqual((await call(h, { action: 'promo_upgrade' }, as(MANAGER))).body.filter(x => x.live), []);
});

test('the generator: one shared code or a batch of single-use codes on one coupon; expired codes switch off', async () => {
  const w = world(), h = staff(ENV, w.fetch);
  const one = await call(h, { action: 'promo_batch', prefix: 'BLACKFRIDAY26', type: 'percentage', value: 30, ends: later(5), limit: 100 }, as(MANAGER));
  assert.strictEqual(one.status, 200, JSON.stringify(one.body)); assert.deepStrictEqual(one.body.map(x => x.code), ['BLACKFRIDAY26']);
  assert.match((await call(h, { action: 'promo_batch', prefix: 'BLACKFRIDAY26', type: 'percentage', value: 30 }, as(MANAGER))).body.error, /already exists/);
  const many = await call(h, { action: 'promo_batch', prefix: 'winter 26', count: 5, type: 'fixed', value: 5, ends: later(90) }, as(MANAGER));
  assert.strictEqual(many.body.length, 5); assert.ok(many.body.every(x => /^WINTER-26-[A-Z0-9]{4}$/.test(x.code) && x.batch === 'WINTER-26' && x.limit === 1));
  assert.strictEqual(new Set(many.body.map(x => x.code)).size, 5);
  assert.strictEqual(w.calls.filter(c => c.url.endsWith('/coupons')).length, 2);   // one coupon per batch
  assert.match((await call(h, { action: 'promo_batch', prefix: 'OLDIE', type: 'fixed', value: 5, ends: later(-1) }, as(MANAGER))).body.error, /future/);
  // listing codes runs the "switch off what expired" job
  await call(h, { action: 'promos' }, as(MANAGER));
  assert.ok(w.rpcs.some(r => r.name === 'a3_expire'));
});

test('portal 2.5: next bill with credit, add a code to a plan, edit contact details, email a receipt', async () => {
  const w = world(), store = checkout(ENV, w.fetch), H = { 'x-forwarded-for': '4.4.4.4' };
  const { order } = await buy(w, { plan: 'business', tier: 'pro', customer: { ...PAT, email: 'kim@co.com' } });
  const me = { order: order.order_id, email: 'kim@co.com' };
  w.customers[order.stripe_customer_id] = { balance: -2500 };   // $25 referral credit
  w.sub(order.stripe_subscription_id); w.subs[order.stripe_subscription_id].items.data[0].price.unit_amount = 14900;
  const v = (await call(store, { action: 'portal', ...me }, H)).body;
  assert.strictEqual(v.next.credit, 25); assert.strictEqual(v.next.amount, 124); assert.ok(v.next.date);
  assert.deepStrictEqual(v.order.contact, { first: 'Pat', last: 'Doe', phone: '919-555-0100', company: 'Doe Labs LLC', title: 'Owner', billing_email: '' });
  // a code on an existing plan
  const h = staff(ENV, w.fetch); await call(h, { action: 'promo_save', code: 'LOYAL5', type: 'fixed', value: 5 }, as(MANAGER));
  assert.match((await call(store, { action: 'portal_code', ...me, code: 'REF-ABCDEF' }, H)).body.error, /Referral codes are for new orders/);
  assert.match((await call(store, { action: 'portal_code', ...me, code: 'NOPE' }, H)).body.error, /isn't a working code/);
  const pc = await call(store, { action: 'portal_code', ...me, code: 'loyal5' }, H);
  assert.strictEqual(pc.status, 200, JSON.stringify(pc.body)); assert.strictEqual(w.subUpdates.pop().form.get('promotion_code'), 'promo_LOYAL5');
  assert.strictEqual(pc.body.next.discount, 5); assert.strictEqual(pc.body.order.history.at(-1).code, 'LOYAL5');
  // contact details (not the email they sign in with)
  assert.match((await call(store, { action: 'portal_contact', ...me, contact: { first: 'Kim', company: '' } }, H)).body.error, /business name/);
  const ct = await call(store, { action: 'portal_contact', ...me, contact: { first: 'Kim', last: 'Park', phone: '555', company: 'Park Studio', billing_email: 'Bills@Park.co', email: 'evil@x.co' } }, H);
  assert.strictEqual(ct.status, 200, JSON.stringify(ct.body)); assert.strictEqual(order.customer_name, 'Kim Park'); assert.strictEqual(order.customer_email, 'kim@co.com');
  assert.strictEqual(ct.body.order.contact.billing_email, 'bills@park.co'); assert.strictEqual(w.customers[order.stripe_customer_id].name, 'Kim Park');
  // the billing email works for looking it up too
  assert.strictEqual((await call(store, { action: 'portal', order: order.order_id, email: 'bills@park.co' }, H)).status, 200);
  // receipt: 3 an hour
  for (let i = 0; i < 3; i++) assert.strictEqual((await call(store, { action: 'portal_receipt', ...me }, H)).status, 200);
  assert.strictEqual(w.emails.at(-1).template_params.to_email, 'kim@co.com');
  assert.strictEqual((await call(store, { action: 'portal_receipt', ...me }, H)).status, 429);
});
