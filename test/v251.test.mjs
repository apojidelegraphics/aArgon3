// aARgon3 2.5.1: editing codes and deals after they're made, Stripe retries, version checks.
import test from 'node:test';
import assert from 'node:assert';
import { handler as staff } from '../supabase/functions/staff/handler.mjs';
import { stripe, SERVER_VERSION } from '../supabase/functions/_shared/lib.mjs';
import { ENV, world, OWNER, MANAGER, EMPLOYEE } from './fakes.mjs';
import fs from 'node:fs';

const req = (body, headers = {}) => new Request('https://fn.test/', { method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'https://apojidelegraphics.github.io', ...headers }, body: JSON.stringify(body) });
const call = async (h, body, headers) => { const r = await h(req(body, headers)); return { status: r.status, body: await r.json().catch(() => null) }; };
const M = { authorization: `Bearer ${MANAGER}` };
const later = d => new Date(Date.now() + d * 864e5).toISOString();
const stripeCalls = (w, from) => w.calls.slice(from).filter(c => c.url.includes('api.stripe.com')).map(c => `${c.method} ${c.url.replace('https://api.stripe.com/v1/', '')}`);

test('edit a code: scope changes stay in the database; discount, end date or limit swap in a fresh Stripe code', async () => {
  const w = world(), h = staff(ENV, w.fetch);
  const made = (await call(h, { action: 'promo_save', code: 'FALL20', type: 'percentage', value: 20, limit: 100, ends: later(10) }, M)).body;
  assert.strictEqual((await call(h, { action: 'promo_save', id: made.id, value: 30 }, { authorization: `Bearer ${EMPLOYEE}` })).status, 403);

  // plans, tiers, minimum, description: no Stripe calls at all
  let n = w.calls.length;
  let r = (await call(h, { action: 'promo_save', id: made.id, plans: ['business'], tiers: ['pro'], min_total: 20, description: 'Fall sale' }, M)).body;
  assert.deepStrictEqual([r.plans, r.tiers, r.min_total, r.description], [['business'], ['pro'], 20, 'Fall sale']); assert.ok(r.edited_by);
  assert.deepStrictEqual(stripeCalls(w, n), []);

  // a new discount: new coupon, old promotion code off, new one on with the limit that's left
  w.promos.find(x => x.id === made.id).used = 40;
  n = w.calls.length;
  r = (await call(h, { action: 'promo_save', id: made.id, value: 30, duration: 'repeating', duration_months: 2 }, M)).body;
  assert.strictEqual(r.value, 30); assert.strictEqual(r.live, true);
  const seq = stripeCalls(w, n);
  assert.deepStrictEqual(seq.map(s => s.split('?')[0]), ['POST coupons', `POST promotion_codes/${made.stripe_promo_id}`, 'POST promotion_codes']);
  const pcBody = w.calls.filter(c => c.url.endsWith('/v1/promotion_codes')).pop().body;
  assert.match(pcBody, /max_redemptions=60/); assert.match(pcBody, /code=FALL20/);
  assert.notStrictEqual(r.stripe_promo_id, made.stripe_promo_id);
  assert.match(w.calls.filter(c => c.url.endsWith('/v1/coupons')).pop().body, /percent_off=30.*duration=repeating|duration=repeating.*percent_off=30/);

  // only the end date: same coupon (read from Stripe), fresh promotion code
  n = w.calls.length;
  r = (await call(h, { action: 'promo_save', id: made.id, ends: later(30) }, M)).body;
  assert.deepStrictEqual(stripeCalls(w, n).map(s => s.split(' ')[0] + ' ' + s.split(' ')[1].replace(/\/.*/, '/…')), ['GET promotion_codes/…', 'POST promotion_codes/…', 'POST promotion_codes']);

  // rename
  r = (await call(h, { action: 'promo_save', id: made.id, code: 'autumn 30' }, M)).body;
  assert.strictEqual(r.code, 'AUTUMN-30'); assert.ok(w.promoCodesStripe.includes('AUTUMN-30')); assert.ok(!w.promoCodesStripe.includes('FALL20'));
  await call(h, { action: 'promo_save', code: 'TAKEN1', type: 'percentage', value: 5 }, M);
  const before = w.promoCodesStripe.slice();
  assert.match((await call(h, { action: 'promo_save', id: made.id, code: 'TAKEN1' }, M)).body.error, /already/);
  assert.deepStrictEqual(w.promoCodesStripe.slice().sort(), before.sort(), 'Stripe put back how it was');
  assert.match((await call(h, { action: 'promo_save', id: made.id, code: 'REF-ABC' }, M)).body.error, /REF-/);
});

test('a failed Stripe swap puts the old code back on', async () => {
  const w = world(), h = staff(ENV, w.fetch);
  const made = (await call(h, { action: 'promo_save', code: 'SAFE10', type: 'percentage', value: 10 }, M)).body;
  w.failPromo = true;
  const r = await call(h, { action: 'promo_save', id: made.id, value: 50 }, M);
  assert.strictEqual(r.status, 502); assert.match(r.body.error, /Stripe said no/);
  assert.ok(w.promoCodesStripe.includes('SAFE10'), 'old code switched back on');
  assert.strictEqual(w.promos.find(x => x.id === made.id).value, 10, 'database unchanged');
});

test('switching codes back on: needs to be in date and under the limit, then gets a fresh Stripe code', async () => {
  const w = world(), h = staff(ENV, w.fetch);
  const made = (await call(h, { action: 'promo_save', code: 'OLDIE', type: 'fixed', value: 5, limit: 10 }, M)).body;
  const x = w.promos.find(p => p.id === made.id);
  Object.assign(x, { active: false, live: false, ended_reason: 'used up', used: 10 });
  w.promoCodesStripe = w.promoCodesStripe.filter(c => c !== 'OLDIE');
  assert.match((await call(h, { action: 'promo_save', id: made.id, active: true }, M)).body.error, /Raise the use limit above that/);
  let r = (await call(h, { action: 'promo_save', id: made.id, active: true, limit: 25 }, M)).body;
  assert.strictEqual(r.active, true); assert.strictEqual(r.ended_reason, null); assert.ok(w.promoCodesStripe.includes('OLDIE'));
  assert.match(w.calls.filter(c => c.url.endsWith('/v1/promotion_codes')).pop().body, /max_redemptions=15/);
  Object.assign(x, { active: false, ended_reason: 'expired', ends: later(-1) });
  assert.match((await call(h, { action: 'promo_save', id: made.id, active: true }, M)).body.error, /end date into the future/);
  r = (await call(h, { action: 'promo_save', id: made.id, active: true, ends: '' }, M)).body;
  assert.strictEqual(r.active, true); assert.strictEqual(r.ends, null);
  // off: just switches the Stripe code off
  r = (await call(h, { action: 'promo_save', id: made.id, active: false }, M)).body;
  assert.strictEqual(r.active, false); assert.ok(!w.promoCodesStripe.includes('OLDIE'));
  // old pre-2.0 codes must be brought over first
  w.promos.push({ id: 77, code: 'old one', type: 'percentage', value: 5, active: true, old: true, used: 0 });
  assert.match((await call(h, { action: 'promo_save', id: 77, value: 9 }, M)).body.error, /Bring this old code over/);
});

test('edit a deal: a changed discount gets a new coupon, perks drop it, toggles stay quick', async () => {
  const w = world(), h = staff(ENV, w.fetch);
  const d = (await call(h, { action: 'deal_save', kind: 'models', models: ['Neodela'], headline: 'Neodela free with Plus', tiers: ['plus'] }, M)).body;
  let n = w.calls.length;
  let r = (await call(h, { action: 'deal_save', id: d.id, tiers: ['plus', 'pro'], ends_at: later(5), headline: 'Neodela free with Plus or Pro' }, M)).body;
  assert.deepStrictEqual(r.tiers, ['plus', 'pro']); assert.strictEqual(r.headline, 'Neodela free with Plus or Pro'); assert.strictEqual(r.name, 'Neodela free with Plus or Pro');
  assert.deepStrictEqual(stripeCalls(w, n), []);
  r = (await call(h, { action: 'deal_save', id: d.id, kind: 'percent', value: 15, duration: 'once' }, M)).body;
  assert.strictEqual(r.kind, 'percent'); assert.strictEqual(r.has_coupon, true); assert.strictEqual(r.models, null);
  assert.match(w.calls.filter(c => c.url.endsWith('/v1/coupons')).pop().body, /percent_off=15/);
  n = w.calls.length;
  r = (await call(h, { action: 'deal_save', id: d.id, headline: 'Plus and Pro: 15% off' }, M)).body;
  assert.deepStrictEqual(stripeCalls(w, n), [], 'same discount, same coupon');
  r = (await call(h, { action: 'deal_save', id: d.id, value: 25 }, M)).body;
  assert.match(r.note, /Orders already placed keep/);
  r = (await call(h, { action: 'deal_save', id: d.id, kind: 'chip', chip: 'Quouk .3o' }, M)).body;
  assert.strictEqual(r.has_coupon, false); assert.strictEqual(r.chip, 'Quouk .3o'); assert.strictEqual(r.value, null);
  assert.match((await call(h, { action: 'deal_save', id: d.id, kind: 'models', models: [] }, M)).body.error, /at least one bonus model/);
  // quick toggles
  r = (await call(h, { action: 'deal_save', id: d.id, featured: false }, M)).body; assert.strictEqual(r.featured, false);
  r = (await call(h, { action: 'deal_save', id: d.id, active: false }, M)).body; assert.strictEqual(r.active, false);
  w.deals.find(x => x.id === d.id).ends_at = later(-1);
  assert.match((await call(h, { action: 'deal_save', id: d.id, active: true }, M)).body.error, /end date into the future/);
  r = (await call(h, { action: 'deal_save', id: d.id, active: true, ends_at: later(3) }, M)).body;
  assert.strictEqual(r.active, true); assert.strictEqual(r.live, true);
});

test('Stripe hiccups are retried with one idempotency key; a dead connection gives a plain message', async () => {
  const w = world(), s = stripe(ENV, w.fetch);
  w.flaky = 2;
  const c = await s('POST', 'coupons', { name: 'RETRY', percent_off: 5, duration: 'once' });
  assert.strictEqual(c.id, 'co_RETRY');
  const keys = w.calls.filter(x => x.url.endsWith('/v1/coupons')).map(x => x.headers['Idempotency-Key']);
  assert.strictEqual(keys.length, 3); assert.strictEqual(new Set(keys).size, 1);
  w.flaky = 3;
  await assert.rejects(s('GET', 'customers/cus_1'), /hiccup/);
  w.flaky = 0;
  const dead = stripe(ENV, async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(dead('GET', 'customers/cus_1'), /Can't reach Stripe/);
});

test('version check: me says which server and database it is; an unknown action says the server is older', async () => {
  const w = world(), h = staff(ENV, w.fetch);
  const me = (await call(h, { action: 'me' }, { authorization: `Bearer ${OWNER}` })).body;
  assert.strictEqual(me.server, SERVER_VERSION); assert.strictEqual(me.db, '2.5.1');
  w.noVersion = true;
  assert.strictEqual((await call(h, { action: 'me' }, { authorization: `Bearer ${OWNER}` })).body.db, null);
  const r = await call(h, { action: 'promo_teleport' }, M);
  assert.strictEqual(r.status, 400); assert.match(r.body.error, /older than the app .*deploy the functions/);
});

test('versions agree: package.json, the terminal, the server functions and the newest SQL file', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
  const term = fs.readFileSync(new URL('../terminal/terminal.js', import.meta.url), 'utf8');
  assert.strictEqual(term.match(/APP_VERSION = '([\d.]+)'/)[1], pkg);
  assert.strictEqual(SERVER_VERSION, pkg);
  const need = term.match(/NEED_DB = '([\d.]+)'/)[1];
  const sql = fs.readFileSync(new URL(`../supabase/aargon3-${need}.sql`, import.meta.url), 'utf8');
  assert.match(sql, new RegExp(`a3_version\\(\\) returns text language sql immutable as \\$\\$ select '${need.replace(/\./g, '\\.')}'`));
});
