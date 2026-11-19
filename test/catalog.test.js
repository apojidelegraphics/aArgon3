// Prices, order contents and order numbers, and that the generated copies match catalog.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const crypto = require('crypto');
const { build, OUT } = require('../scripts/catalog');
const { core } = require('../scripts/core');

const C = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'catalog.json'), 'utf8'));
const A3 = core(C);

test('generated catalog files are up to date (run `npm run catalog`)', () => {
  const b = build();
  assert.strictEqual(fs.readFileSync(OUT.web, 'utf8'), b.web, 'assets/catalog.js is stale');
  assert.strictEqual(fs.readFileSync(OUT.server, 'utf8'), b.server, 'supabase/functions/_shared/catalog.mjs is stale');
});

test('prices', () => {
  assert.deepStrictEqual(A3.price('personal', 'standard', 'month'), { amount: 6, cents: 600, interval: 'month', seats: 1, quote: false, monthly: 6 });
  assert.strictEqual(A3.price('business', 'max', 'year').amount, 2990);   // 10 months
  assert.strictEqual(A3.price('business', 'pro', 'month').seats, 7);
  assert.strictEqual(A3.price('enterprise', 'max', 'month').quote, true);
  assert.strictEqual(A3.price('enterprise', 'max', 'month').seats, null);
  assert.throws(() => A3.price('personal', 'ultra', 'month'), /tier/);
  // every non-quote plan has a price for every tier, rising with the tier
  for (const p of A3.PLANS.filter(p => !C.plans[p].quote)) {
    const list = A3.TIERS.map(t => A3.price(p, t, 'month').amount);
    assert.ok(list.every((v, i) => i === 0 || v > list[i - 1]), `${p} prices rise`);
  }
});

test('selection is checked and cleaned up', () => {
  const s = A3.selection({ plan: 'Business', tier: 'PRO', billing: 'year', os: 'nope', connection: 'Apoji Cloud', email: ' a@b.co ' });
  assert.deepStrictEqual(s, { plan: 'business', tier: 'pro', billing: 'year', os: C.os[0].id, connection: 'Apoji Cloud', email: 'a@b.co' });
  assert.throws(() => A3.selection({ plan: 'x', tier: 'pro' }), /Personal, Business or Enterprise/);
  assert.throws(() => A3.selection({ plan: 'personal', tier: 'pro', email: 'not-an-email' }), /email/);
  assert.strictEqual(A3.selection({ plan: 'personal', tier: 'pro', billing: 'weekly' }).billing, 'month');
});

test('orders carry what Nexus reads', () => {
  const sel = A3.selection({ plan: 'personal', tier: 'max', os: 'LentOS 27.2 Sonoma', connection: 'HLS (Home Lentintity Server)' });
  const cfg = A3.config(sel);
  assert.deepStrictEqual([cfg.os, cfg.chip, cfg.connection, cfg.plan_type, cfg.service_tier], ['LentOS 27.2 Sonoma', 'Quouk .3o', 'HLS (Home Lentintity Server)', 'Personal', 'Max']);
  const names = A3.items('max').map(i => i.model);
  assert.ok(names.includes('Neodela') && names.includes('Lyte-28') && !names.includes('Flash'), 'Max unlocks Lyte + Neodela/classic, not free Flash');
  assert.deepStrictEqual(A3.items('standard').map(i => i.model), ['Lyte-28', 'Lyte-27', 'Lyte-2.6']);
});

test('order numbers are random and match what Nexus accepts', () => {
  const NEXUS = /^[A-Z0-9]{4,}-[A-Z0-9]{2,}$/;   // src/cloud.js redeem()
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const id = A3.orderId(n => crypto.randomBytes(n));
    assert.match(id, NEXUS); assert.match(id, /^[A-HJ-NP-Z2-9]{8}-[A-HJ-NP-Z2-9]{4}$/);
    seen.add(id);
  }
  assert.strictEqual(seen.size, 2000);
});
