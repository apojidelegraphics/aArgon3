// POST /functions/v1/checkout — the public store.
//   { action: 'start', plan, tier, billing, os, connection, customer: {first, last, email, …}, promo }  → { url }   (send the browser to Stripe)
//   { action: 'status', session_id }                     → { ready, order }    (the thank-you page)
//   { action: 'promo', code, plan, tier, billing }       → { label, after }    ("Apply" on a promo code)
//   { action: 'info' }                                   → { open, message }   (is the store taking orders?)
//   { action: 'request', plan, tier, seats, interval, models, chip, os, connection, customer, notes }
//                                                        → { quote_no }        (the "Custom" tab: lands in the terminal's Custom orders)
// 2.4 — the customer portal (order number + email), gifts, referral codes, tax by region, store hours:
//   { action: 'stores' }                                 → { stores, closures }   (the Stores page)
//   { action: 'portal', order, email }                   → { order, invoices }    (account.html)
//   { action: 'portal_change', order, email, plan, tier, billing, apply }   → price difference, or the change itself
//   { action: 'portal_pause' | 'portal_resume' | 'portal_cancel' | 'portal_keep' | 'portal_card', order, email, … }
//   { action: 'gift_check', code } / { action: 'gift_claim', code, customer }
// 2.5 — deals on the store page and at checkout; the portal also shows the next bill and credit, takes a code, edits contact details,
// and emails a receipt:  { action: 'portal_code' | 'portal_contact' | 'portal_receipt', order, email, … }
// Needs secrets STRIPE_SECRET_KEY and SITE_URL (https://apojidelegraphics.github.io/aArgon3).
import { A3, cors, json, Oops, db, stripe, startCheckout, sessionStatus, checkPromo, storeInfo, newQuoteNo, taxFor, cleanGift, giftPrice, mailer,
  subInfo, invoicesFor, planChange, pauseSub, resumeSub, cancelAtEnd, billingPortal, publicOrder, storeStatus, GIFT_MONTHS,
  liveDeals, applyDeals, publicDeal, nextBill, codeOnPlan, receiptParams } from '../_shared/lib.mjs';

export function handler(env, fetchImpl = fetch, now = () => Date.now()) {
  const rpc = db(env, fetchImpl), call = stripe(env, fetchImpl);
  const site = (env.SITE_URL || 'https://apojidelegraphics.github.io/aArgon3').replace(/\/$/, '');
  // the portal: number + email must match; 10 wrong tries an hour (per IP or per order number) and it waits
  async function portalOrder(b, req) {
    const ip = (req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || '').split(',')[0].trim() || 'unknown';
    const id = String(b.order || '').toUpperCase().trim().slice(0, 20), keys = [`ip:${ip}`, `order:${id}`];
    if (!id || !b.email) throw new Oops('Enter your order number and the email you used.');
    if (await rpc('a3_portal_attempt', { p_keys: keys, p_failed: false }) >= 10) throw new Oops('Too many tries. Wait an hour and try again, or email us.', 429);
    const o = await rpc('a3_portal_order', { p_order: id, p_email: String(b.email).slice(0, 120) });
    if (!o) { await rpc('a3_portal_attempt', { p_keys: keys, p_failed: true }); throw new Oops("We couldn't find an order with that number and email. Check both and try again.", 404); }
    const st = await rpc('a3_order_stripe', { p_order: o.order_id });
    return { ...o, subscription: st?.subscription || null, customer: st?.customer || null };
  }
  async function portalView(o) {
    const sub = o.subscription ? await subInfo(call, o.subscription).catch(() => null) : null;
    const [invoices, s, next] = await Promise.all([invoicesFor(call, o), rpc('a3_settings').catch(() => ({})), o.status === 'ACTIVE' ? nextBill(call, o).catch(() => null) : null]);
    const order = publicOrder({ ...o, stripe_customer: !!o.customer }, sub);
    order.history = (o.history || []).map(h => ({ kind: h.kind, at: h.at, from: h.from, to: h.to, months: h.months, code: h.code, due_now: h.due_now, credit: h.credit }));
    order.deals = o.deals || [];
    order.contact = { first: o.customer_info?.first || (o.customer_name || '').split(' ')[0] || '', last: o.customer_info?.last || (o.customer_name || '').split(' ').slice(1).join(' '),
      phone: o.customer_phone || '', company: o.company_name || '', title: o.customer_info?.title || '', billing_email: o.customer_info?.billing_email || '' };
    order.can.code = !!o.subscription && ['ACTIVE', 'PAUSED'].includes(o.status);
    return { order, invoices, next, referral_enabled: s?.referral?.enabled !== false };
  }
  return async function (req) {
    const h = cors(req);
    if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405, h);
    try {
      const b = await req.json().catch(() => ({}));
      if (b.action === 'info') {
        const i = await storeInfo(rpc, now()), t = i.settings?.tax;
        // tax rates (no Stripe ids) so the store can show an estimate before checkout
        const tax = t?.enabled ? { label: t.label || 'Sales tax', rates: Object.fromEntries(Object.entries(t.regions || {}).map(([r, x]) => [r, Number(x.rate) || 0])) } : null;
        const deals = (await liveDeals(rpc)).map(publicDeal);
        return json({ open: i.open, message: i.message, closures: i.closures || [], tax, referrals: i.settings?.referral?.enabled !== false, gifts: GIFT_MONTHS, deals }, 200, h);
      }
      if (b.action === 'stores') {
        const pub = await rpc('a3_stores_public');
        return json({ ...pub, stores: pub.stores.map(x => ({ ...x, now: storeStatus(x, pub.closures, now()) })) }, 200, h);
      }
      if (b.action === 'start') {
        const info = await storeInfo(rpc, now());
        if (!info.open) throw new Oops(info.message || 'The store is closed for now. Please check back soon.', 409);
        const sel = A3.selection(b);
        const customer = A3.customer(sel.plan, b.customer || { email: b.email });
        const gift = b.gift ? cleanGift(b.gift, customer) : null;
        const region = A3.C.regions[b.region] ? b.region : null;
        const amount = gift ? giftPrice(sel, gift.months).amount : A3.price(sel.plan, sel.tier, sel.billing).amount;
        const promo = b.promo ? await checkPromo({ rpc, code: b.promo, sel, amount, email: customer.email }) : null;
        if (promo?.kind === 'referral' && gift) throw new Oops('Referral codes work on your own plan, not on gifts.');
        const deals = gift ? null : applyDeals(await liveDeals(rpc), sel, { promo });
        const r = await startCheckout({ call, siteUrl: site, sel, customer, promo, gift, region, deals, tax: taxFor(info.settings, region), followup: !!b.followup, nowSec: Math.floor(now() / 1000) });
        return json({ url: r.url }, 200, h);
      }
      if (b.action === 'promo') {
        const sel = A3.selection(b), p = A3.price(sel.plan, sel.tier, sel.billing);
        const x = await checkPromo({ rpc, code: b.code, sel, amount: p.amount, email: b.email });
        if (!x) throw new Oops('Enter a code.');
        return json({ code: x.code, label: x.label, after: x.after, before: p.amount, duration: x.duration }, 200, h);
      }
      if (b.action === 'request') {
        if (b.website) return json({ quote_no: newQuoteNo() }, 200, h);   // a bot filled the hidden field: pretend it worked
        const info = await storeInfo(rpc);
        if (!info.open) throw new Oops(info.message || 'The store is closed for now. Please check back soon.', 409);
        const sel = A3.selection({ plan: b.plan, tier: b.tier, billing: 'month', os: b.os, connection: b.connection });
        const customer = A3.customer(sel.plan, b.customer || {});
        const interval = ['month', 'year', 'once'].includes(b.interval) ? b.interval : 'month';
        const seats = b.seats ? Math.max(1, Math.min(100000, Math.round(Number(b.seats)) || 1)) : A3.price(sel.plan, sel.tier, 'month').seats;
        const all = Object.values(A3.C.families).flatMap(f => f.models);
        const models = Array.isArray(b.models) && b.models.length ? [...new Set(b.models.filter(m => all.includes(m)))].slice(0, 60) : A3.items(sel.tier).map(i => i.model);
        const chip = A3.C.chips.some(c => c.id === b.chip && c.id !== 'No order') ? b.chip : A3.C.tiers[sel.tier].chip;
        const budget = b.budget == null || b.budget === '' ? null : Math.max(0, Math.min(10000000, Number(b.budget) || 0));
        const notes = String(b.notes || '').slice(0, 1500).trim();
        const r = await rpc('a3_quote_request', { p: { quote_no: newQuoteNo(), plan: sel.plan, tier: sel.tier, seats, interval,
          config: { ...A3.config(sel), chip, seats, billing: interval }, customer, notes: notes || null,
          items: models.map(model => ({ model, price: 0, family: Object.keys(A3.C.families).find(f => A3.C.families[f].models.includes(model)) })),
          request: { budget, interval, seats, models, chip, notes, at: new Date().toISOString() } } });
        return json({ quote_no: r.quote_no }, 200, h);
      }
      if (b.action === 'status') {
        const s = await rpc('a3_settings').catch(() => ({}));
        const r = await sessionStatus({ rpc, call, sessionId: b.session_id, mail: mailer(env, fetchImpl, s) });
        // the thank-you page shows a gift's code (so the buyer can hand it over) and the buyer's own referral code
        if (r.ready && r.order?.order_id) {
          const o = await rpc('a3_order', { p_order: r.order.order_id }).catch(() => null);
          if (o) r.order = { ...r.order, referral_code: o.referral_code, tax: o.tax, region: o.region,
            gift: o.gift ? { code: o.gift.code, months: o.gift.months, to_name: o.gift.to_name, to_email: o.gift.to_email } : null };
        }
        return json(r, 200, h);
      }
      // ---------- customer portal
      if (b.action === 'portal') return json(await portalView(await portalOrder(b, req)), 200, h);
      if (b.action === 'portal_change') {
        const o = await portalOrder(b, req);
        const sel = A3.selection({ plan: b.plan, tier: b.tier, billing: b.billing, os: o.config?.os, connection: o.config?.connection });
        const r = await planChange({ call, rpc, o, sel, apply: !!b.apply, by: 'customer', nowSec: Math.floor(now() / 1000) });
        return json(b.apply ? { ...r, ...(await portalView({ ...o, ...r.order })) } : r, 200, h);
      }
      if (b.action === 'portal_pause') { const o = await portalOrder(b, req); await pauseSub({ call, rpc, o, months: b.months, nowSec: Math.floor(now() / 1000) }); return json(await portalView(await portalOrder(b, req)), 200, h); }
      if (b.action === 'portal_resume') { const o = await portalOrder(b, req); await resumeSub({ call, rpc, o }); return json(await portalView(await portalOrder(b, req)), 200, h); }
      if (b.action === 'portal_cancel' || b.action === 'portal_keep') {
        const o = await portalOrder(b, req);
        await cancelAtEnd({ call, rpc, o, undo: b.action === 'portal_keep' });
        return json(await portalView(await portalOrder(b, req)), 200, h);
      }
      if (b.action === 'portal_code') {
        const o = await portalOrder(b, req);
        const r = await codeOnPlan({ call, rpc, o, code: String(b.code || '') });
        return json({ ...r, ...(await portalView(await portalOrder(b, req))) }, 200, h);
      }
      if (b.action === 'portal_contact') {
        const o = await portalOrder(b, req);
        const key = Object.keys(A3.C.plans).find(k => A3.C.plans[k].name === o.plan) || 'personal';
        const c = b.contact || {}, clean = v => String(v ?? '').trim().slice(0, 120);
        const p = { first: clean(c.first), last: clean(c.last), phone: clean(c.phone), title: clean(c.title) };
        if (key !== 'personal') p.company = clean(c.company);
        if (c.billing_email) { if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.billing_email)) throw new Oops("That billing email doesn't look right."); p.billing_email = clean(c.billing_email).toLowerCase(); }
        if (!p.first) throw new Oops('Add your first name.');
        if (key !== 'personal' && !p.company) throw new Oops(`Add the ${key === 'enterprise' ? 'corporate entity' : 'business'} name.`);
        await rpc('a3_order_contact', { p_order: o.order_id, p });
        if (o.customer) await call('POST', `customers/${o.customer}`, { name: `${p.first} ${p.last}`.trim(), ...(p.phone ? { phone: p.phone } : {}) }).catch(() => {});
        return json(await portalView(await portalOrder(b, req)), 200, h);
      }
      if (b.action === 'portal_receipt') {
        const o = await portalOrder(b, req);
        // 3 an hour per order is plenty
        if (await rpc('a3_portal_attempt', { p_keys: [`receipt:${o.order_id}`], p_failed: true }) > 3) throw new Oops('We just sent it. Check your inbox (and spam folder).', 429);
        const s = await rpc('a3_settings').catch(() => ({}));
        await mailer(env, fetchImpl, s).receipt(receiptParams(o, { store: s?.business?.name || 'aARgon3', to: o.customer_email }));
        return json({ sent: true, to: o.customer_email }, 200, h);
      }
      if (b.action === 'portal_card') { const o = await portalOrder(b, req); return json({ url: await billingPortal({ call, customer: o.customer, returnUrl: `${site}/account.html` }) }, 200, h); }
      // ---------- gifts
      if (b.action === 'gift_check' || b.action === 'gift_claim') {
        const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown', keys = [`ip:${ip}`];
        if (await rpc('a3_portal_attempt', { p_keys: keys, p_failed: false }) >= 10) throw new Oops('Too many tries. Wait an hour and try again.', 429);
        const g = await rpc('a3_gift', { p_code: String(b.code || '').slice(0, 20) });
        if (!g) { await rpc('a3_portal_attempt', { p_keys: keys, p_failed: true }); throw new Oops("That gift code isn't right. Check it and try again.", 404); }
        if (b.action === 'gift_check') return json({ gift: g }, 200, h);
        if (g.claimed) throw new Oops('That gift has already been claimed.');
        const key = Object.keys(A3.C.plans).find(k => A3.C.plans[k].name === g.plan) || 'personal';
        const customer = A3.customer(key, b.customer || {});
        const o = await rpc('a3_gift_claim', { p_code: g.code, p_customer: customer });
        return json({ order: { order_id: o.order_id, plan: o.plan, tier: o.tier, expires_at: o.expires_at, models: o.models } }, 200, h);
      }
      throw new Oops('Unknown action.');
    } catch (e) {
      const status = e instanceof Oops ? e.status : 400;
      if (status >= 500) console.error('[checkout]', e);
      return json({ error: e.message || 'Something went wrong.' }, status, h);
    }
  };
}
