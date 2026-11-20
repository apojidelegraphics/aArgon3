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
  // ---------- customer and company details (what the old aARgon3 asked for, per plan)
  // Returns { first, last, name, email, phone, company, title, node, jurisdiction, billing_email } or throws a readable error.
  function customer(plan, input = {}, { partial = false } = {}) {
    const fields = C.fields[plan] || C.fields.personal, out = {};
    for (const f of fields) {
      let v = String(input[f.key] ?? '').trim().slice(0, f.key === 'company' ? 160 : 120);
      if (f.type === 'email') v = v.toLowerCase();
      if (!v && f.required && !partial) throw new Error(`${f.label} is required.`);
      if (v && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error(`${f.label} doesn't look right.`);
      if (v && f.type === 'tel' && !/^[+()\d\s.-]{7,20}$/.test(v)) throw new Error(`${f.label} doesn't look like a phone number.`);
      out[f.key] = v;
    }
    out.name = [out.first, out.last].filter(Boolean).join(' ');
    return out;
  }
  // Omni-QNCN node IDs like the old terminal made: OS generation + three blocks, e.g. 28-12a3-45B6-78c9
  function nodeId(os, rand = Math.random) {
    const gen = /LentOS 27/.test(os || '') ? '27' : '28', d = () => Math.floor(rand() * 10);
    const l = () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(rand() * 52)];
    const part = () => `${d()}${d()}${l()}${d()}`;
    return `${gen}-${part()}-${part()}-${part()}`;
  }
  function jurisdiction(region, rand = Math.random) {
    const keys = Object.keys(C.regions), r = C.regions[region] ? region : keys[Math.floor(rand() * 4)];
    return `${C.regions[r]}-${Math.floor(rand() * 1000)}`;
  }
  // a starting point for an Enterprise quote: per-person price × people, never under the minimum
  function enterpriseSuggest(tier, seats, interval = 'month') {
    const e = C.plans.enterprise, per = e.perSeatMonthly?.[tier] || 0, n = Math.max(Number(seats) || 0, e.seats.standard);
    const monthly = Math.max(e.fromMonthly, Math.round(per * n));
    return interval === 'year' ? monthly * C.yearlyMonths : monthly;
  }

  const money = (n, cur = C.currency) => n == null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase(), minimumFractionDigits: n % 1 ? 2 : 0 }).format(n);

  return { C, TIERS, PLANS, price, selection, items, config, label, describe, orderId, money, customer, nodeId, jurisdiction, enterpriseSuggest };
}

module.exports = { core };
