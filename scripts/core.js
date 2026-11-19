// aARgon3 core: prices, order contents and order numbers. Written once here and copied (by scripts/catalog.js) into
// assets/catalog.js for the store and terminal, and into supabase/functions/_shared/catalog.js for the server.
// The server never trusts a price sent by a browser: it works the price out again with these same functions.

function core(C) {
  const TIERS = C.tierOrder, PLANS = C.planOrder;
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  // { amount, cents, interval, seats, quote } for a plan + tier + billing ('month' | 'year')
  function price(plan, tier, billing) {
    const p = C.plans[plan], t = C.tiers[tier];
    if (!p || !t) throw new Error('Pick a plan and a tier.');
    const interval = billing === 'year' ? 'year' : 'month';
    const seats = p.seats[tier] ?? null;
    if (p.quote) return { amount: null, cents: null, interval, seats, quote: true, from: p.fromMonthly };
    const monthly = p.monthly[tier];
    const amount = interval === 'year' ? monthly * C.yearlyMonths : monthly;
    return { amount, cents: Math.round(amount * 100), interval, seats, quote: false, monthly };
  }

  // Checks a customer's or staff member's choices; returns them cleaned up, or throws a readable error.
  function selection(s = {}) {
    const plan = String(s.plan || '').toLowerCase(), tier = String(s.tier || '').toLowerCase();
    if (!PLANS.includes(plan)) throw new Error('Pick Personal, Business or Enterprise.');
    if (!TIERS.includes(tier)) throw new Error('Pick Standard, Plus, Pro or Max.');
    const billing = s.billing === 'year' ? 'year' : 'month';
    const os = C.os.find(o => o.id === s.os)?.id || C.os[0].id;
    const connection = C.connections.find(o => o.id === s.connection)?.id || C.connections[0].id;
    const email = String(s.email || '').trim().slice(0, 200);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("That email doesn't look right.");
    return { plan, tier, billing, os, connection, email };
  }

  // What Nexus '28 reads from an order: the item list (each model on it becomes unlimited) and the system config.
  function items(tier) {
    return C.tiers[tier].families.flatMap(f => C.families[f].models.map(model => ({ model, price: 0, family: f })));
  }
  function config(sel) {
    return { os: sel.os, chip: C.tiers[sel.tier].chip, connection: sel.connection, plan_type: C.plans[sel.plan].name,
      service_tier: C.tiers[sel.tier].name, billing: sel.billing, catalog: C.version };
  }
  // "aARgon3 Business · Pro"
  function label(sel) { return `aARgon3 ${C.plans[sel.plan].name} · ${C.tiers[sel.tier].name}`; }
  function describe(sel) {
    const p = price(sel.plan, sel.tier, sel.billing);
    const people = p.seats == null ? 'no set limit on people' : p.seats === 1 ? '1 person' : `up to ${p.seats} people`;
    return `${C.tiers[sel.tier].tagline} ${cap(people)}. ${sel.os} on ${C.tiers[sel.tier].chip}, ${sel.connection}.`;
  }

  // Order numbers like 7KQ2XW9M-RT4P. Random (not time-based) so nobody can guess someone else's.
  // Uses only letters and digits that are hard to mix up; Nexus accepts any A–Z / 0–9.
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function orderId(randomBytes) {
    const b = randomBytes(12); let s = '';
    for (let i = 0; i < 12; i++) s += ALPHABET[b[i] % 32];
    return s.slice(0, 8) + '-' + s.slice(8);
  }
  const money = (n, cur = C.currency) => n == null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase(), minimumFractionDigits: n % 1 ? 2 : 0 }).format(n);

  return { C, TIERS, PLANS, price, selection, items, config, label, describe, orderId, money };
}

module.exports = { core };
