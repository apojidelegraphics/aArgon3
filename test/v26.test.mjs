// aARgon3 2.6: Apoji-wide. Link a Nexus account to an order with a one-time code; one search for staff.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { handler as checkout } from '../supabase/functions/checkout/handler.mjs';
import { handler as webhook } from '../supabase/functions/stripe-webhook/handler.mjs';
import { handler as staff } from '../supabase/functions/staff/handler.mjs';
import { apojiLook } from '../supabase/functions/_shared/lib.mjs';
import { ENV, world, MANAGER, EMPLOYEE } from './fakes.mjs';

const req = (body, headers = {}) => new Request('https://fn.test/', { method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'https://apojidelegraphics.github.io', 'x-forwarded-for': '6.6.6.6', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const call = async (h, body, headers) => { const r = await h(req(body, headers)); return { status: r.status, body: await r.json().catch(() => null) }; };
const signed = (body, t = Math.floor(Date.now() / 1000)) => ({ 'stripe-signature': `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex')}` });
async function buy(w) {
  const store = checkout(ENV, w.fetch), hook = webhook(ENV, w.fetch);
  const r = await call(store, { action: 'start', plan: 'business', tier: 'pro', billing: 'month', customer: { first: 'Kim', last: 'Park', email: 'kim@northwind.co', company: 'Northwind Studio LLC', title: 'Ops' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const s = Object.values(w.sessions).pop(); s.status = 'complete'; s.payment_status = 'paid';
  const b = JSON.stringify({ type: 'checkout.session.completed', data: { object: s } }); await call(hook, b, signed(b));
  return w.orders[s.metadata.a3_order];
}
const PIC = 'https://yzbnxpkuhlxsuwzbjifx.supabase.co/storage/v1/object/public/avatars/u1/avatar.webp';

test('link a Nexus account to an order with a one-time code; unlink it', async () => {
  const w = world(), store = checkout(ENV, w.fetch), o = await buy(w), me = { order: o.order_id, email: 'kim@northwind.co' };
  w.linkCodes = { KIMCODE1: { username: 'kimp', nickname: 'Kim', display_name: 'Kim P.', avatar_url: PIC, frame: 'frame:neon', color: 'color:mint', pframe: 'pframe:hud', owner: false, email: 'leak@x.co', id: 'u1' } };
  assert.match((await call(store, { action: 'portal_link', ...me, code: 'abc' })).body.error, /8 letters/);
  assert.strictEqual((await call(store, { action: 'portal_link', order: o.order_id, email: 'wrong@x.co', code: 'KIMCODE1' })).status, 404, 'needs the right email first');
  let r = await call(store, { action: 'portal_link', ...me, code: 'kim-code1' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const a = r.body.order.apoji;
  assert.deepStrictEqual([a.username, a.display_name, a.avatar_url, a.frame, a.pframe], ['kimp', 'Kim P.', PIC, 'frame:neon', 'pframe:hud']);
  assert.ok(!('email' in a) && !('id' in a), 'nothing private kept');
  assert.deepStrictEqual(w.nexusCalls.at(-1), { p_code: 'KIMCODE1', p_app: 'aARgon3' });
  assert.ok(r.body.order.history.some(h => h.kind === 'apoji_link' && h.username === 'kimp'));
  // used codes don't work again
  r = await call(store, { action: 'portal_link', ...me, code: 'KIMCODE1' });
  assert.strictEqual(r.status, 404); assert.match(r.body.error, /works once/);
  // staff see it on the order
  const staffOrder = (await call(staff(ENV, w.fetch), { action: 'order', order_id: o.order_id }, { authorization: `Bearer ${MANAGER}` })).body;
  assert.strictEqual((staffOrder.order || staffOrder).apoji.username, 'kimp');
  r = await call(store, { action: 'portal_unlink', ...me });
  assert.strictEqual(r.body.order.apoji, null);
  // Nexus side not set up yet
  w.noNexusLink = true;
  assert.match((await call(store, { action: 'portal_link', ...me, code: 'ANYCODE1' })).body.error, /isn't switched on yet/);
});

test('wrong link codes count towards the hourly limit', async () => {
  const w = world(), store = checkout(ENV, w.fetch), o = await buy(w), me = { order: o.order_id, email: 'kim@northwind.co' };
  for (let i = 0; i < 10; i++) await call(store, { action: 'portal_link', ...me, code: `WRONG00${i}`.slice(0, 8) });
  assert.strictEqual((await call(store, { action: 'portal_link', ...me, code: 'WRONG999' })).status, 429);
});

test('apojiLook keeps only the public look and only Nexus picture links', () => {
  assert.deepStrictEqual(apojiLook({ username: 'a', avatar_url: 'https://evil.example/x.png', email: 'x', owner: 'yes' }), { username: 'a', owner: false });
  assert.strictEqual(apojiLook({ username: 'a', avatar_url: PIC }).avatar_url, PIC);
});

test('one search: employees find orders (also by Nexus username), managers also codes', async () => {
  const w = world(), h = staff(ENV, w.fetch), o = await buy(w);
  o.apoji = { username: 'kimp' };
  await call(h, { action: 'promo_save', code: 'NORTHWIND10', type: 'percentage', value: 10 }, { authorization: `Bearer ${MANAGER}` });
  let r = (await call(h, { action: 'search', q: 'kimp' }, { authorization: `Bearer ${EMPLOYEE}` })).body;
  assert.deepStrictEqual(r.map(x => [x.kind, x.id]), [['order', o.order_id]]);
  assert.strictEqual(w.searches.at(-1).p_manager, false);
  r = (await call(h, { action: 'search', q: 'northwind' }, { authorization: `Bearer ${MANAGER}` })).body;
  assert.deepStrictEqual(r.map(x => x.kind).sort(), ['order', 'promo']);
  assert.deepStrictEqual((await call(h, { action: 'search', q: 'k' }, { authorization: `Bearer ${MANAGER}` })).body, []);
});

test('Nexus-side SQL file adds aARgon3 presence, status parts and the fuller public profile', () => {
  const sql = fs.readFileSync(new URL('../supabase/nexus-side/aargon3-2.6-in-nexus.sql', import.meta.url), 'utf8');
  assert.match(sql, /'aargon3'\)\) then return|'admin', 'aargon3'\)/);
  assert.match(sql, /'aargon3_store'/); assert.match(sql, /'aargon3_terminal'/);
  assert.match(sql, /'display_name', coalesce\(s\.display_name/);
  assert.doesNotMatch(sql, /'email'/, 'never returns an email');
});
