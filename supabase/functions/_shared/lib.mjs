// Shared by the aARgon3 Edge Functions (checkout, stripe-webhook, staff). Plain JavaScript with no imports, so the
// same file runs in Supabase (Deno) and in the tests (Node). Everything that needs the outside world (fetch, env,
// random bytes, the clock) is passed in, which is what lets the tests swap Stripe and Supabase for fakes.
import { A3 } from './catalog.mjs';

export { A3 };

// ---------- HTTP
// The store and the terminal on GitHub Pages, the desktop app, and local testing.
const ORIGINS = [/^https:\/\/apojidelegraphics\.github\.io$/, /^aargon3:\/\/app$/, /^apoji:\/\/admin$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
export function cors(req, extra = []) {
  const o = req.headers.get('origin') || '';
  const ok = ORIGINS.some(r => r.test(o)) || extra.includes(o);
  return { 'Access-Control-Allow-Origin': ok ? o : 'https://apojidelegraphics.github.io', Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
}
export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
export class Oops extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

// ---------- Supabase (this project, with the service key: only the functions have it)
export function db(env, fetchImpl = fetch) {
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  return async function rpc(name, args = {}) {
    const res = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = data?.message || `Database error (${res.status}).`;
      // our own "raise exception" messages are written for people; Postgres' own ones aren't
      throw new Oops(data?.code === 'P0001' ? msg : /function .* does not exist|PGRST202/.test(msg + (data?.code || '')) ? 'The aARgon3 SQL (aargon3-2.0.sql) hasn\'t been run yet.' : msg, data?.code === 'P0001' ? 400 : 500);
    }
    return data;
  };
}

// ---------- Stripe (REST, pinned API version so field names never change under us)
export const STRIPE_VERSION = '2024-06-20';
export const SERVER_VERSION = '2.6.0';   // the terminal compares this with its own version
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Nexus (the Apoji account): public URL + publishable key, safe to ship
export const NEXUS_URL = 'https://yzbnxpkuhlxsuwzbjifx.supabase.co';
export const NEXUS_KEY = 'sb_publishable_LY-EZORCvEQqW6AeQC5a8w_Z7wmeyjn';
export const UNSET = '\u0000unset';   // sends "field=" so Stripe clears it (e.g. pause_collection)
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === UNSET) { out.append(prefix ? `${prefix}[${k}]` : k, ''); continue; }
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out); else out.append(key, String(v));
  }
  return out;
}
export const qs = obj => form(obj).toString();
export function stripe(env, fetchImpl = fetch) {
  const key = env.STRIPE_SECRET_KEY;
  // 2.5.1: a dropped connection, rate limit or Stripe hiccup is tried again (twice). Every POST carries one Idempotency-Key
  // for all its tries, so a retry can never make a second coupon, charge or refund.
  return async function call(method, path, body) {
    if (!key) throw new Oops('Payments aren\'t set up yet (STRIPE_SECRET_KEY is missing).', 503);
    const idem = method === 'POST' ? globalThis.crypto.randomUUID() : null;
    for (let i = 0; ; i++) {
      let res;
      try {
        res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
          method, headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_VERSION, ...(idem ? { 'Idempotency-Key': idem } : {}), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
          body: body ? form(body).toString() : undefined });
      } catch {
        if (i < 2) { await sleep(400 * (i + 1)); continue; }
        throw new Oops('Can\'t reach Stripe right now. Try again in a minute.', 503);
      }
      if ((res.status === 429 || res.status >= 500) && i < 2) { await sleep(400 * (i + 1)); continue; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Oops(data?.error?.message || `Stripe error (${res.status}).`, 502);
      return data;
    }
  };
}

// Stripe-Signature: t=…,v1=… is an HMAC-SHA256 of "t.body" with the webhook's signing secret.
export async function verifyStripeSignature(body, header, secret, nowSec, toleranceSec = 300) {
  if (!secret) throw new Oops('STRIPE_WEBHOOK_SECRET is missing.', 500);
  const parts = Object.fromEntries(String(header || '').split(',').map(p => p.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header || '').split(',').filter(p => p.trim().startsWith('v1=')).map(p => p.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) throw new Oops('Missing Stripe signature.', 400);
  if (Math.abs(nowSec - t) > toleranceSec) throw new Oops('Stripe signature is too old.', 400);
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(`${t}.${body}`)));
  const hex = Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
  const same = s => s.length === hex.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0;
  if (!sigs.some(same)) throw new Oops('Bad Stripe signature.', 400);
  return JSON.parse(body);
}

// ---------- checkout
const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));
export const newOrderId = () => A3.orderId(randomBytes);
export const newQuoteNo = () => 'Q-' + A3.orderId(randomBytes).replace('-', '').slice(0, 6);
const sid = v => (typeof v === 'string' ? v : v?.id) || null;

// Everything about one order travels to Stripe as metadata (so the receipt, the webhook and the thank-you page all agree)
// and comes back from it in fulfill(). Stripe allows 50 keys of up to 500 characters each.
const CUSTOMER_KEYS = ['first', 'last', 'email', 'phone', 'company', 'title', 'node', 'jurisdiction', 'billing_email'];
function toMeta({ orderId, sel, customer = {}, staff = null, custom = null, promo = null, region = null, gift = null, followup = false, deals = null }) {
  const m = { a3_order: orderId, a3_plan: sel.plan, a3_tier: sel.tier, a3_billing: sel.billing, a3_os: sel.os, a3_connection: sel.connection,
    a3_source: custom ? 'custom' : staff ? 'terminal' : 'web', a3_staff: staff?.id, a3_operator: staff?.name, a3_shift: staff?.shiftId,
    a3_promo: promo && promo.kind !== 'referral' ? promo.code : undefined, a3_ref: promo?.kind === 'referral' ? promo.code : undefined,
    a3_region: region || undefined, a3_followup: followup ? '1' : undefined,
    a3_gift: gift ? '1' : undefined, a3_gift_months: gift?.months, a3_gift_to: gift?.to_name, a3_gift_to_email: gift?.to_email, a3_gift_from: gift?.from_name,
    a3_gift_msg: gift?.message ? String(gift.message).slice(0, 480) : undefined,
    a3_quote: custom?.quote_no, a3_seats: custom?.seats, a3_chip: custom?.chip || deals?.chip || undefined,
    a3_deals: deals?.applied?.length ? deals.applied.map(d => d.id).join(',') : undefined, a3_bonus: deals?.models?.length ? deals.models.join(',').slice(0, 490) : undefined,
    a3_seats_add: deals?.seats || undefined,
    a3_models: custom?.models?.length ? custom.models.join(',').slice(0, 490) : undefined, a3_interval: custom?.interval };
  for (const k of CUSTOMER_KEYS) if (customer[k]) m['a3_c_' + k] = String(customer[k]).slice(0, 490);
  for (const k of Object.keys(m)) if (m[k] === undefined || m[k] === null || m[k] === '') delete m[k];
  return m;
}
function fromMeta(m = {}) {
  const customer = {}; for (const k of CUSTOMER_KEYS) if (m['a3_c_' + k]) customer[k] = m['a3_c_' + k];
  customer.name = [customer.first, customer.last].filter(Boolean).join(' ');
  return { customer, seats: m.a3_seats ? Number(m.a3_seats) : null, chip: m.a3_chip || null, models: m.a3_models ? m.a3_models.split(',').filter(Boolean) : null,
    quote_no: m.a3_quote || null, promo: m.a3_promo || null, interval: m.a3_interval || null, region: m.a3_region || null, referral: m.a3_ref || null,
    deals: m.a3_deals ? m.a3_deals.split(',').map(Number).filter(Boolean) : [], bonus: m.a3_bonus ? m.a3_bonus.split(',').filter(Boolean) : [], seatsAdd: Number(m.a3_seats_add) || 0,
    gift: m.a3_gift ? { months: Number(m.a3_gift_months) || 1, to_name: m.a3_gift_to || '', to_email: m.a3_gift_to_email || '', from_name: m.a3_gift_from || '', message: m.a3_gift_msg || '' } : null };
}

// The row a3_record_order writes, from Stripe metadata plus what Stripe tells us about the payment.
function orderRecord(m, extra) {
  const x = fromMeta(m);
  const sel = A3.selection({ plan: m.a3_plan, tier: m.a3_tier, billing: m.a3_billing, os: m.a3_os, connection: m.a3_connection });
  const config = { ...A3.config(sel), ...(x.chip ? { chip: x.chip } : {}), ...(x.seats ? { seats: x.seats } : {}), ...(x.interval === 'once' || x.gift ? { billing: 'once' } : {}),
    ...(x.gift ? { gift_months: x.gift.months } : {}) };
  const fam = model => Object.keys(A3.C.families).find(f => A3.C.families[f].models.includes(model)) || 'custom';
  let items = x.models ? x.models.map(model => ({ model, price: 0, family: fam(model) })) : A3.items(sel.tier);
  // deals: bonus models on top of what the tier includes
  for (const model of x.bonus) if (!items.some(i => i.model === model)) items = [...items, { model, price: 0, family: fam(model), deal: true }];
  const baseSeats = x.seats || A3.price(sel.plan, sel.tier, 'month').seats;
  if (x.seatsAdd && baseSeats != null) config.seats = baseSeats + x.seatsAdd;
  const c = x.customer;
  return { ...extra, order_id: m.a3_order || newOrderId(), plan_type: A3.C.plans[sel.plan].name, tier: sel.tier, billing: x.interval === 'once' || x.gift ? 'once' : sel.billing,
    config, items, seats: baseSeats != null && x.seatsAdd ? baseSeats + x.seatsAdd : baseSeats, source: m.a3_source || 'web', staff_user_id: m.a3_staff || null,
    operator: m.a3_operator || null, shift_id: m.a3_shift || null, quote_no: x.quote_no, promo_code: x.promo,
    customer_name: c.name || extra.customer_name || '', customer_email: c.email || extra.customer_email || '', customer_phone: c.phone || extra.customer_phone || '',
    company_name: c.company || '', node_id: c.node || '', target_jurisdiction: c.jurisdiction || '',
    customer_info: Object.keys(c).length > 1 ? c : null, payment_method: extra.payment_method || 'card' };
}

// A Stripe Checkout page. The order number is made now, so it's printed on Stripe's receipt and invoices; the order
// itself is only written once Stripe says it's paid (fulfill below).
//   sel       plan, tier, billing, os, connection (checked by A3.selection)
//   customer  the person and company (checked by A3.customer)
//   staff     { id, name, shiftId } for a sale in the terminal
//   custom    { amount_cents, interval: 'month'|'year'|'once', seats, models, chip, quote_no } for custom orders / Enterprise quotes
//   promo     a checked promotion ({ code, stripe_promo_id })
//   region    A–E: picks the tax rate (tax = { stripe_id, rate, label } from taxFor)
//   gift      { months: 1|3|6|12, to_name, to_email, from_name, message }: a one-time payment the recipient claims with a code
//   followup  the customer ticked "email me if I don't finish": a reminder if this checkout expires
//   deals     from applyDeals: price deal (a Stripe coupon, only when no code is used), bonus models, chip, extra people
export async function startCheckout({ call, siteUrl, sel, customer = {}, staff = null, custom = null, promo = null, region = null, tax = null, gift = null, followup = false, deals = null, nowSec = Math.floor(Date.now() / 1000) }) {
  if (custom || gift) deals = null;   // deals are for regular orders
  const p = A3.price(sel.plan, sel.tier, sel.billing);
  if (p.quote && !custom) throw new Oops(`Enterprise is quoted for your team. Email ${A3.C.contactEmail} and we'll set it up.`);
  if (gift && (custom || p.quote)) throw new Oops('Gifts are for Personal and Business plans.');
  const orderId = newOrderId(), interval = gift ? 'once' : custom?.interval || p.interval, cents = gift ? giftPrice(sel, gift.months).cents : custom ? custom.amount_cents : p.cents;
  if (!Number.isInteger(cents) || cents < 50) throw new Oops('The price has to be at least $0.50.');
  const meta = toMeta({ orderId, sel, customer, staff, custom, promo, region, gift, followup: followup && !staff && !custom, deals });
  // a referral is a one-time coupon worth a month of the plan they're buying
  let discounts = promo && promo.kind !== 'referral' ? { 0: { promotion_code: promo.stripe_promo_id } } : undefined;
  if (promo?.kind === 'referral') {
    const coupon = await call('POST', 'coupons', { amount_off: Math.min(promo.amount_off_cents, cents), currency: A3.C.currency, duration: 'once', max_redemptions: 1,
      name: 'Referral: 1 month off', metadata: { a3_ref: promo.code, a3_order: orderId } });
    discounts = { 0: { coupon: coupon.id } };
  }
  if (!discounts && deals?.price?.stripe_coupon_id) discounts = { 0: { coupon: deals.price.stripe_coupon_id } };
  const site = siteUrl.replace(/\/$/, '');
  const seats = custom?.seats || p.seats;
  const name = gift ? `Gift: ${A3.C.plans[sel.plan].name} ${A3.C.tiers[sel.tier].name} for ${gift.months} month${gift.months === 1 ? '' : 's'} · Order ${orderId}`
    : `${A3.label(sel)}${custom?.seats ? ` (${custom.seats} people)` : ''} · Order ${orderId}`;
  const dealNote = deals?.applied?.length ? ` Deal${deals.applied.length > 1 ? 's' : ''}: ${deals.applied.map(d => d.headline).join('; ')}.` : '';
  const desc = gift ? `For ${gift.to_name || 'someone special'}${gift.from_name ? `, from ${gift.from_name}` : ''}. They claim it with a gift code; the months start when they do.` : custom ? `${A3.C.tiers[sel.tier].tagline} ${seats ? `For ${seats} ${seats === 1 ? 'person' : 'people'}. ` : ''}${sel.os} on ${custom.chip || A3.C.tiers[sel.tier].chip}.${custom.quote_no ? ` Quote ${custom.quote_no}.` : ''}`
    : A3.describe(sel);
  const once = interval === 'once';
  const session = await call('POST', 'checkout/sessions', {
    mode: once ? 'payment' : 'subscription',
    line_items: { 0: { quantity: 1, price_data: { currency: A3.C.currency, unit_amount: cents, ...(once ? {} : { recurring: { interval } }),
      product_data: { name, description: (desc + dealNote).slice(0, 500) } }, ...(tax?.stripe_id ? { tax_rates: { 0: tax.stripe_id } } : {}) } },
    customer_email: customer.email || sel.email || undefined,
    ...(discounts ? { discounts } : {}),
    // web checkouts expire after 3 hours (that's when a reminder can go out); staff and custom-order links keep Stripe's 24 hours
    ...(!staff && !custom ? { expires_at: nowSec + 3 * 3600 } : {}),
    billing_address_collection: 'auto',
    ...(once ? { customer_creation: 'always', invoice_creation: { enabled: 'true', invoice_data: { metadata: meta, description: `aARgon3 order ${orderId}` } }, payment_intent_data: { metadata: meta } }
             : { subscription_data: { description: `aARgon3 order ${orderId}`, metadata: meta } }),
    success_url: `${site}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: staff ? `${site}/success.html?cancelled=1` : `${site}/${planLink(sel)}`,
    metadata: meta,
    custom_text: { submit: { message: `Your order number is ${orderId}. By paying you agree to the aARgon3 Terms of Sale: ${site}/terms/` } }
  });
  return { url: session.url, session_id: session.id, order_id: orderId, amount: cents / 100, interval };
}

// Writes the order for a paid Checkout Session (from the webhook, or from the thank-you page if the webhook is late).
// Safe to call more than once: the database ignores a session it has already seen.
export async function fulfill({ rpc, session, call = null, mail = null }) {
  const paid = session.status === 'complete' && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required');
  if (!paid) return null;
  const m = session.metadata || {};
  if (!m.a3_plan) return null;
  const r = await rpc('a3_record_order', { p: orderRecord(m, {
    stripe_session_id: session.id, stripe_subscription_id: sid(session.subscription), stripe_customer_id: sid(session.customer),
    stripe_invoice_id: sid(session.invoice), first_invoice_id: sid(session.invoice), amount_cents: session.amount_total ?? 0, discount_cents: session.total_details?.amount_discount || 0,
    currency: session.currency || A3.C.currency, customer_name: session.customer_details?.name || '', customer_email: session.customer_details?.email || session.customer_email || '',
    customer_phone: session.customer_details?.phone || '' }) });
  if (r?.created !== false) await afterOrder({ rpc, call, mail, orderId: r?.order_id || m.a3_order, meta: m, taxCents: session.total_details?.amount_tax || 0,
    subscriptionId: sid(session.subscription), email: session.customer_details?.email || session.customer_email || m.a3_c_email }).catch(e => console.error('[afterOrder]', e));
  return r;
}

// Thank-you page / terminal: is this session's order ready? Checks Stripe directly if the webhook hasn't run yet.
export async function sessionStatus({ rpc, call, sessionId, mail = null }) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(String(sessionId || ''))) throw new Oops('That checkout link isn\'t valid.');
  let order = await rpc('a3_order_by_session', { p_session: sessionId });
  if (order) return { ready: true, order };
  const session = await call('GET', `checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (session.status === 'expired') return { ready: false, state: 'expired' };
  if (session.status !== 'complete') return { ready: false, state: 'open' };
  if (session.payment_status === 'unpaid') return { ready: false, state: 'processing' };
  await fulfill({ rpc, session, call, mail });
  order = await rpc('a3_order_by_session', { p_session: sessionId });
  return order ? { ready: true, order } : { ready: false, state: 'processing' };
}

// ---------- invoices (custom orders and Enterprise quotes)
// Stripe emails the customer an invoice with a "Pay" link. Recurring quotes become a subscription billed by invoice.
export async function sendInvoice({ call, sel, customer, custom, staff, daysUntilDue = 30, region = null, tax = null }) {
  const orderId = newOrderId(), meta = toMeta({ orderId, sel, customer, staff, custom, region });
  const rates = tax?.stripe_id ? { 0: tax.stripe_id } : undefined;
  const email = customer.billing_email || customer.email;
  if (!email) throw new Oops('Add the customer\'s email (or a billing email) to send an invoice.');
  const cus = await call('POST', 'customers', { email, name: customer.company || customer.name || undefined, phone: customer.phone || undefined,
    description: customer.company ? `${customer.name} · ${customer.company}` : undefined, metadata: { a3_quote: custom.quote_no } });
  const name = `${A3.label(sel)}${custom.seats ? ` (${custom.seats} people)` : ''} · Order ${orderId}`;
  const days = Math.min(Math.max(Number(daysUntilDue) || 30, 1), 90);
  let invoice;
  if (custom.interval === 'once') {
    await call('POST', 'invoiceitems', { customer: cus.id, amount: custom.amount_cents, currency: A3.C.currency, description: name, metadata: meta, tax_rates: rates });
    invoice = await call('POST', 'invoices', { customer: cus.id, collection_method: 'send_invoice', days_until_due: days, metadata: meta,
      pending_invoice_items_behavior: 'include', description: `aARgon3 order ${orderId}${custom.quote_no ? ` · Quote ${custom.quote_no}` : ''}` });
  } else {
    const product = await call('POST', 'products', { name, metadata: { a3_quote: custom.quote_no } });
    const sub = await call('POST', 'subscriptions', { customer: cus.id, collection_method: 'send_invoice', days_until_due: days, metadata: meta, default_tax_rates: rates,
      description: `aARgon3 order ${orderId}`, items: { 0: { price_data: { currency: A3.C.currency, product: product.id, unit_amount: custom.amount_cents, recurring: { interval: custom.interval } } } } });
    invoice = { id: sid(sub.latest_invoice), subscription: sub.id };
  }
  const fin = await call('POST', `invoices/${invoice.id}/finalize`, { auto_advance: 'true' });
  const sent = await call('POST', `invoices/${invoice.id}/send`).catch(() => fin);   // the sandbox only emails your own team's addresses
  return { order_id: orderId, invoice_id: invoice.id, subscription_id: invoice.subscription || null, url: sent.hosted_invoice_url || fin.hosted_invoice_url, email };
}

// invoice.paid: the first payment of an invoiced quote creates the order; later ones are renewals.
export async function invoicePaid({ rpc, call, invoice }) {
  const subId = sid(invoice.subscription) || sid(invoice.parent?.subscription_details?.subscription);
  let m = (invoice.metadata && invoice.metadata.a3_plan) ? invoice.metadata
    : invoice.subscription_details?.metadata?.a3_plan ? invoice.subscription_details.metadata
    : invoice.parent?.subscription_details?.metadata?.a3_plan ? invoice.parent.subscription_details.metadata : null;
  if (!m && subId) { const sub = await call('GET', `subscriptions/${encodeURIComponent(subId)}`); m = sub.metadata?.a3_plan ? sub.metadata : null; }
  if (!m) return { ignored: 'not an aARgon3 invoice' };
  const amount = invoice.amount_paid ?? invoice.total ?? 0;
  const first = invoice.billing_reason === 'subscription_create' || invoice.billing_reason === 'manual' || !subId;
  if (first && m.a3_quote) {
    const r = await rpc('a3_record_order', { p: orderRecord(m, { stripe_invoice_id: invoice.id, first_invoice_id: invoice.id, stripe_subscription_id: subId,
      stripe_customer_id: sid(invoice.customer), amount_cents: amount, currency: invoice.currency || A3.C.currency,
      customer_email: invoice.customer_email || '', customer_name: invoice.customer_name || '', payment_method: 'invoice' }) });
    if (r?.created !== false) await afterOrder({ rpc, call, orderId: r?.order_id || m.a3_order, meta: m, taxCents: invoice.tax || 0, subscriptionId: subId }).catch(e => console.error('[afterOrder]', e));
    return { order: r?.order_id };
  }
  if (!subId) return { ignored: 'one-time checkout invoice' };
  // first invoices of checkout subscriptions are already counted by fulfill (same invoice id)
  const kind = first ? 'first' : invoice.billing_reason === 'subscription_update' ? 'change' : 'renewal';
  const rec = await rpc('a3_record_payment', { p_invoice: invoice.id, p_subscription: subId, p_amount_cents: amount, p_kind: kind });
  // keep the renewal date fresh
  const end = invoice.lines?.data?.find(l => l.period?.end)?.period?.end;
  if (end && kind !== 'change') await rpc('a3_subscription_sync', { p_subscription: subId, p: { current_period_end: new Date(end * 1000).toISOString() } }).catch(() => {});
  return rec;
}

// ---------- promotions
export function discountLabel(x) {
  const off = x.type === 'percentage' ? `${Number(x.value)}% off` : `${A3.money(Number(x.value))} off`;
  const how = x.duration === 'forever' ? 'every payment' : x.duration === 'repeating' ? `for ${x.duration_months} months` : 'the first payment';
  return `${off} ${how}`;
}
export function discounted(amount, x) {
  const after = x.type === 'percentage' ? amount * (1 - Number(x.value) / 100) : amount - Number(x.value);
  return Math.max(0, Math.round(after * 100) / 100);
}
// Is this code good for this plan / tier / price? Returns the promotion, or throws a readable reason.
export async function checkPromo({ rpc, code, sel, amount, email = '' }) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  if (/^REF-/.test(c)) return checkReferral({ rpc, code: c, sel, email });
  const x = await rpc('a3_promo', { p_code: c });
  if (!x || !x.live || !x.stripe_promo_id) throw new Oops(`"${c}" isn't a working code.`);
  if (x.plans?.length && !x.plans.includes(sel.plan)) throw new Oops(`${c} doesn't work on the ${A3.C.plans[sel.plan].name} plan.`);
  if (x.tiers?.length && !x.tiers.includes(sel.tier)) throw new Oops(`${c} works on ${x.tiers.map(t => A3.C.tiers[t]?.name || t).join(' and ')} only.`);
  if (Number(x.min_total) > 0 && amount < Number(x.min_total)) throw new Oops(`${c} needs an order of ${A3.money(Number(x.min_total))} or more.`);
  return { ...x, label: discountLabel(x), after: discounted(amount, x) };
}

// Store open? (settings → store)
export async function storeInfo(rpc, at = Date.now()) {
  let s;
  try { s = await rpc('a3_settings'); } catch { return { open: true, message: '', business: {}, settings: {} }; }   // before aargon3-2.1.sql
  const out = { open: s?.store?.open !== false, message: s?.store?.message || '', business: s?.business || {}, settings: s || {} };
  if (out.open) {
    const pub = await rpc('a3_stores_public').catch(() => null);   // before aargon3-2.4.sql
    const c = onlineClosure(pub?.closures || [], at);
    if (c) { out.open = false; out.closure = c; out.message = `The online store is closed${c.reason ? ` for ${c.reason}` : ''}. We're back ${niceDate(addDays(c.ends_on, 1))}.`; }
    out.closures = (pub?.closures || []).filter(x => !x.store_code);
  }
  return out;
}

// ================================================================ 2.4
// ---------- dates (the business runs on Eastern time)
export const TZ = 'America/New_York';
const ymd = (at, tz = TZ) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
const hm = (at, tz = TZ) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const dayKey = (at, tz = TZ) => DAYS[new Date(`${ymd(at, tz)}T12:00:00Z`).getUTCDay()];
export const todayIn = (at = Date.now(), tz = TZ) => ymd(at, tz);
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const niceDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

// ---------- store hours and closures
export const onlineClosure = (closures, at = Date.now()) => { const t = ymd(at); return closures.find(c => !c.store_code && c.starts_on <= t && c.ends_on >= t) || null; };
// { open: true|false|null (no hours set), label: "9 AM–9 PM" | "Closed today", reason }
export function storeStatus(store, closures = [], at = Date.now()) {
  const t = ymd(at), c = closures.find(x => x.store_code === store.code && x.starts_on <= t && x.ends_on >= t);
  if (c) return { open: false, label: 'Closed today', reason: c.reason || 'Closed', closure: c };
  const h = store.hours?.[dayKey(at)];
  if (!store.hours) return { open: null, label: '' };
  if (!h) return { open: false, label: 'Closed today' };
  const now = hm(at);
  return { open: now >= h[0] && now < h[1], label: `${h[0]}–${h[1]}`, opens: h[0], closes: h[1] };
}
export function cleanHours(input) {
  if (input == null) return null;
  const out = {};
  for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
    const v = input[d];
    if (!v) { out[d] = null; continue; }
    const [a, b] = v.map(x => String(x || ''));
    if (!/^\d{2}:\d{2}$/.test(a) || !/^\d{2}:\d{2}$/.test(b) || a >= b) throw new Oops(`${d[0].toUpperCase() + d.slice(1)}: opening has to be before closing (HH:MM).`);
    out[d] = [a, b];
  }
  return out;
}

// ---------- tax by region (owner sets a rate per region; each rate is a Stripe tax rate so receipts and invoices show it)
export function taxFor(settings, region) {
  const t = settings?.tax;
  if (!t?.enabled || !region) return null;
  const r = t.regions?.[region];
  return r && Number(r.rate) > 0 && r.stripe_id ? { region, rate: Number(r.rate), label: t.label || 'Sales tax', stripe_id: r.stripe_id } : null;
}
export async function saveTax({ call, value, old = {} }) {
  const label = String(value.label || 'Sales tax').slice(0, 50), regions = {};
  for (const r of Object.keys(A3.C.regions)) {
    const rate = Math.round(Math.max(0, Math.min(30, Number(value.regions?.[r]?.rate) || 0)) * 1000) / 1000;
    const prev = old.regions?.[r];
    if (!rate) { if (prev?.stripe_id) await call('POST', `tax_rates/${prev.stripe_id}`, { active: 'false' }).catch(() => {}); continue; }
    if (prev?.stripe_id && Number(prev.rate) === rate && (old.label || 'Sales tax') === label) { regions[r] = prev; continue; }
    // Stripe tax rates can't change percentage: make a new one, retire the old one
    const x = await call('POST', 'tax_rates', { display_name: label, percentage: rate, inclusive: 'false', jurisdiction: `Region ${r} · ${A3.C.regions[r]}`.slice(0, 50),
      description: `aARgon3 region ${r}`, metadata: { a3_region: r } });
    if (prev?.stripe_id) await call('POST', `tax_rates/${prev.stripe_id}`, { active: 'false' }).catch(() => {});
    regions[r] = { rate, stripe_id: x.id };
  }
  return { enabled: !!value.enabled, label, regions };
}

// ---------- links back to the store with a plan picked
export const planLink = sel => `?plan=${sel.plan}&tier=${sel.tier}&billing=${sel.billing}#plans`;

// ---------- gifts: 1, 3, 6 or 12 months paid once (12 months costs the yearly price)
export const GIFT_MONTHS = [1, 3, 6, 12];
export function giftPrice(sel, months) {
  if (!GIFT_MONTHS.includes(Number(months))) throw new Oops('Gifts are 1, 3, 6 or 12 months.');
  const m = A3.price(sel.plan, sel.tier, 'month');
  if (m.quote) throw new Oops('Gifts are for Personal and Business plans.');
  const cents = Number(months) === 12 ? A3.price(sel.plan, sel.tier, 'year').cents : m.cents * Number(months);
  return { cents, amount: cents / 100 };
}
export const newGiftCode = () => 'GIFT-' + A3.orderId(randomBytes).replace('-', '').slice(0, 8).replace(/(.{4})(.{4})/, '$1-$2');
export const newReferralCode = () => 'REF-' + A3.orderId(randomBytes).replace('-', '').slice(0, 6);
export function cleanGift(g, buyer = {}) {
  if (!g) return null;
  const to_name = String(g.to_name || '').trim().slice(0, 80);
  if (to_name.length < 1) throw new Oops("Who's the gift for? Add their name.");
  const to_email = String(g.to_email || '').trim().toLowerCase().slice(0, 120);
  if (to_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to_email)) throw new Oops("Their email doesn't look right (or leave it empty and give them the code yourself).");
  return { months: Number(g.months), to_name, to_email, from_name: String(g.from_name || buyer.first || '').trim().slice(0, 80), message: String(g.message || '').trim().slice(0, 300) };
}

// ---------- referral codes: the new customer gets a month off; the person who referred them gets a month of credit
export async function checkReferral({ rpc, code, sel, email = '' }) {
  const s = await rpc('a3_settings').catch(() => ({}));
  if (s?.referral?.enabled === false) throw new Oops('Referral codes are switched off right now.');
  const ref = await rpc('a3_referrer', { p_code: code });
  if (!ref) throw new Oops(`"${code}" isn't a working code.`);
  if (email && ref.email === String(email).trim().toLowerCase()) throw new Oops("That's your own referral code. Share it with a friend instead!");
  const m = A3.price(sel.plan, sel.tier, 'month');
  if (m.quote) throw new Oops('Referral codes work on Personal and Business plans.');
  const amount = A3.price(sel.plan, sel.tier, sel.billing).amount;
  return { kind: 'referral', code, referrer: ref, amount_off_cents: m.cents, label: `1 month off (${A3.money(m.amount)}), thanks to ${ref.name ? ref.name.split(' ')[0] : 'a friend'}`,
    after: Math.max(0, Math.round((amount - m.amount) * 100) / 100), duration: 'once' };
}
async function creditReferrer({ rpc, call, code, newOrder, email }) {
  const s = await rpc('a3_settings').catch(() => ({}));
  const ref = await rpc('a3_referrer', { p_code: code });
  if (!ref) return null;
  if (email && ref.email === String(email).toLowerCase()) return null;
  const max = Number(s?.referral?.max_per_year) || 12;
  const key = Object.keys(A3.C.plans).find(k => A3.C.plans[k].name === ref.plan);
  const cents = key && A3.C.tiers[ref.tier] ? A3.price(key, ref.tier, 'month').cents || 0 : 0;
  let status = 'credited', txn = null, credit = cents;
  if (ref.this_year >= max) { status = 'limit'; credit = 0; }
  else if (!ref.customer || !cents || !call) status = 'pending';   // nothing to put the credit on yet: staff can sort it out
  else {
    // customer balance credit: Stripe takes it off their next invoice automatically
    const t = await call('POST', `customers/${ref.customer}/balance_transactions`, { amount: -cents, currency: A3.C.currency,
      description: `Referral credit: ${newOrder} used your code ${code}`, metadata: { a3_ref: code, a3_order: newOrder } });
    txn = t.id;
  }
  return rpc('a3_referral_record', { p: { code, referrer_order: ref.order_id, new_order: newOrder, new_email: email || null, credit_cents: credit, stripe_txn_id: txn, status } });
}

// ---------- after a new order is written: region/tax, its own referral code, renewal date, gifts, referral credit
async function afterOrder({ rpc, call, mail, orderId, meta: m, taxCents = 0, subscriptionId = null, email = '' }) {
  if (!orderId) return;
  const x = fromMeta(m), patch = { referral_code: newReferralCode(), tax_cents: taxCents };
  if (x.region) patch.region = x.region;
  if (x.referral) patch.referred_by = x.referral;
  if (subscriptionId && call) {
    const sub = await call('GET', `subscriptions/${encodeURIComponent(subscriptionId)}`).catch(() => null);
    if (sub?.current_period_end) patch.current_period_end = new Date(sub.current_period_end * 1000).toISOString();
  }
  let gift = null;
  if (x.gift) {
    gift = { ...x.gift, code: newGiftCode(), from_email: m.a3_c_email || email || '' };
    Object.assign(patch, { status: 'GIFT', gift_code: gift.code, gift, event: { kind: 'gift_bought', months: gift.months } });
  }
  await rpc('a3_order_patch', { p_order: orderId, p: patch });
  if (x.deals.length) {
    const all = await rpc('a3_deals').catch(() => []);
    await rpc('a3_deals_used', { p_ids: x.deals }).catch(() => {});
    await rpc('a3_order_patch_deals', { p_order: orderId, p_deals: all.filter(d => x.deals.includes(d.id)).map(d => ({ id: d.id, headline: d.headline, kind: d.kind })) }).catch(() => {});
  }
  if (x.referral) await creditReferrer({ rpc, call, code: x.referral, newOrder: orderId, email: email || m.a3_c_email }).catch(e => console.error('[referral]', e));
  if (gift && mail) {
    const to = gift.to_email || gift.from_email;
    const claim = `${mail.site}/account.html?gift=${encodeURIComponent(gift.code)}`;
    await mail.message({ to_email: to, to_name: gift.to_email ? gift.to_name : gift.from_name,
      subject: gift.to_email ? `${gift.from_name || 'Someone'} sent you an aARgon3 gift` : `Your aARgon3 gift for ${gift.to_name}`,
      heading: gift.to_email ? `A gift for you, ${gift.to_name}!` : `Here's the gift code for ${gift.to_name}`,
      message: `${gift.to_email ? `${gift.from_name || 'Someone'} gave you` : `You bought ${gift.to_name}`} ${m.a3_plan ? A3.C.plans[m.a3_plan].name : ''} ${A3.C.tiers[m.a3_tier]?.name || ''} for ${gift.months} month${gift.months === 1 ? '' : 's'} in Nexus '28.${gift.message ? `\n\n"${gift.message}"` : ''}\n\nGift code: ${gift.code}\nClaim it at the link below. The months start when it's claimed.`,
      button_label: 'Claim the gift', button_url: claim, code: gift.code }).catch(e => console.error('[gift email]', e));
  }
}

// ---------- email through EmailJS (the same account the old aARgon3 used)
// Settings → Email in the terminal can change the ids; the private key (optional) is the EMAILJS_PRIVATE_KEY secret.
// In EmailJS: Account → Security → "Allow EmailJS API for non-browser applications" must be on.
export const EMAILJS_DEFAULTS = { service_id: 'service_xebrht3', receipt_template: 'template_3lwqybm', public_key: 'GYO37b2vvZjIJiMFC' };
export function mailer(env, fetchImpl = fetch, settings = {}) {
  const e = { ...EMAILJS_DEFAULTS, ...Object.fromEntries(Object.entries(settings?.email || {}).filter(([, v]) => v !== '' && v != null)) };
  const site = (env.SITE_URL || 'https://apojidelegraphics.github.io/aArgon3').replace(/\/$/, '');
  const storeName = settings?.business?.name || 'aARgon3';
  async function send(template, params) {
    if (e.enabled === false) throw new Oops('Email is switched off (Settings → Email).');
    if (!template) throw new Oops('No email template set for this kind of email (Settings → Email).');
    const res = await fetchImpl('https://api.emailjs.com/api/v1.0/email/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_id: e.service_id, template_id: template, user_id: e.public_key, accessToken: env.EMAILJS_PRIVATE_KEY || undefined,
        template_params: { store_name: storeName, from_name: storeName, reply_to: settings?.business?.email || A3.C.contactEmail, site_url: site, ...params, email: params.to_email } }) });
    const text = await res.text();
    if (!res.ok) throw new Oops(`EmailJS: ${text || res.status}`, 502);
    return { sent: true, to: params.to_email };
  }
  return { site, config: e, storeName,
    receipt: params => send(e.receipt_template, params),
    // gifts and reminders use a second, general template (falls back to the receipt one only if you haven't made it)
    message: params => send(e.message_template || null, params) };
}
// the old aARgon3 template's fields, plus the store's name
export function receiptParams(o, { store = '', to = '' } = {}) {
  const items = (o.models || []).length ? o.models.join('\n') : 'Included with your plan';
  const cfg = o.config || {};
  const lines = [store && `Store: ${store}`, `Plan: ${o.plan} ${A3.C.tiers[o.tier]?.name || o.tier || ''}`.trim(), `Billing: ${o.billing === 'year' ? 'Yearly' : o.billing === 'once' ? 'One payment' : 'Monthly'}`,
    o.seats && `People: ${o.seats}`, cfg.os && `LentOS: ${cfg.os}`, cfg.connection && `Connection: ${cfg.connection}`, cfg.chip && `Chip: ${cfg.chip}`,
    o.region && `Region: ${o.region} · ${A3.C.regions[o.region] || ''}`, o.promo_code && `Promo: ${o.promo_code}`, o.referral_code && `Your referral code: ${o.referral_code} (a friend gets a month off, and so do you)`].filter(Boolean);
  const total = Number(o.amount) || 0, tax = Number(o.tax) || 0;
  return { to_email: to || o.customer_email, order_id: o.order_id, customer_name: o.customer_name || 'Customer', node_id: o.node_id || 'N/A', jurisdiction: o.jurisdiction || 'N/A',
    items_text: items, config_text: lines.join('\n'), shipping_cost: '0.00', tax_cost: tax.toFixed(2), total_cost: total.toFixed(2), currency: String(o.currency || A3.C.currency).toUpperCase(),
    store_name: store || undefined, subject: `Your receipt for order ${o.order_id}${store ? ` · ${store}` : ''}`, date: new Date(o.created_at || Date.now()).toLocaleDateString('en-US', { dateStyle: 'long' }),
    referral_code: o.referral_code || '' };
}

// ---------- subscriptions: look, change plan, pause, cancel at period end
export async function subInfo(call, subId) {
  const s = await call('GET', `subscriptions/${encodeURIComponent(subId)}`);
  const item = s.items?.data?.[0];
  return { id: s.id, status: s.status, customer: sid(s.customer), current_period_end: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null,
    cancel_at_period_end: !!s.cancel_at_period_end, cancel_at: s.cancel_at ? new Date(s.cancel_at * 1000).toISOString() : null,
    paused_until: s.pause_collection?.resumes_at ? new Date(s.pause_collection.resumes_at * 1000).toISOString() : s.pause_collection ? 'indefinitely' : null,
    item: item && { id: item.id, amount: (item.price?.unit_amount || 0) / 100, interval: item.price?.recurring?.interval, product: sid(item.price?.product), tax_rates: (item.tax_rates || []).map(t => sid(t)) } };
}
export async function invoicesFor(call, o) {
  if (!o.customer) return [];
  const r = await call('GET', `invoices?${qs({ customer: o.customer, limit: 24 })}`).catch(() => ({ data: [] }));
  return (r.data || []).filter(i => i.status !== 'draft').map(i => ({ number: i.number, date: new Date((i.status_transitions?.paid_at || i.created) * 1000).toISOString(),
    amount: (i.amount_paid || i.total || 0) / 100, tax: (i.tax || 0) / 100, status: i.status, url: i.hosted_invoice_url, pdf: i.invoice_pdf, reason: i.billing_reason }));
}
// What changing to `sel` costs. Upgrades (and switching monthly ↔ yearly) are charged now, with credit for unused time;
// downgrades become credit on the next bill.
export async function planChange({ call, rpc, o, sel, apply = false, by = 'customer', nowSec = Math.floor(Date.now() / 1000) }) {
  if (!o.subscription) throw new Oops('Only subscriptions can change plan. One-time orders stay as they are.');
  if (o.quote_no || o.source === 'custom') throw new Oops('Custom orders and quotes are changed by our team. Reply to your invoice email and we\'ll sort it out.');
  if (['CANCELLED', 'EXPIRED', 'GIFT'].includes(o.status)) throw new Oops(`This order is ${o.status.toLowerCase()}.`);
  const p = A3.price(sel.plan, sel.tier, sel.billing);
  if (p.quote) throw new Oops('Enterprise is quoted for your team: use the Custom tab or email us.');
  const sub = await subInfo(call, o.subscription);
  if (!sub.item) throw new Oops("We couldn't read this subscription from Stripe.");
  const curKey = Object.keys(A3.C.plans).find(k => A3.C.plans[k].name === o.plan);
  if (curKey === sel.plan && o.tier === sel.tier && sub.item.interval === p.interval) throw new Oops("That's the plan you already have.");
  const intervalChange = sub.item.interval !== p.interval;
  const upgrade = intervalChange || p.cents > Math.round(sub.item.amount * 100);
  const priceData = { currency: A3.C.currency, product: sub.item.product, unit_amount: p.cents, recurring: { interval: p.interval } };
  const behavior = upgrade ? 'always_invoice' : 'create_prorations';
  const preview = await call('GET', `invoices/upcoming?${qs({ customer: sub.customer, subscription: sub.id, subscription_proration_date: nowSec, subscription_proration_behavior: behavior,
    subscription_items: { 0: { id: sub.item.id, price_data: priceData, ...(sub.item.tax_rates.length ? { tax_rates: Object.fromEntries(sub.item.tax_rates.map((t, i) => [i, t])) } : {}) } } })}`);
  const prorations = (preview.lines?.data || []).filter(l => l.proration).reduce((m, l) => m + (l.amount || 0), 0);
  const dueNow = upgrade ? Math.max(0, intervalChange ? preview.amount_due ?? preview.total ?? 0 : prorations) : 0;
  const credit = upgrade ? 0 : Math.max(0, -prorations);
  const label = `${A3.C.plans[sel.plan].name} ${A3.C.tiers[sel.tier].name} · ${p.interval === 'year' ? 'yearly' : 'monthly'}`;
  const quote = { from: `${o.plan} ${A3.C.tiers[o.tier]?.name || o.tier} · ${sub.item.interval === 'year' ? 'yearly' : 'monthly'}`, to: label, upgrade,
    due_now: dueNow / 100, credit: credit / 100, new_price: p.amount, interval: p.interval, renews: sub.current_period_end };
  if (!apply) return quote;
  await call('POST', `subscriptions/${sub.id}`, { proration_behavior: behavior, proration_date: nowSec, payment_behavior: 'error_if_incomplete',
    items: { 0: { id: sub.item.id, price_data: priceData, ...(sub.item.tax_rates.length ? { tax_rates: Object.fromEntries(sub.item.tax_rates.map((t, i) => [i, t])) } : {}) } },
    metadata: { a3_plan: sel.plan, a3_tier: sel.tier, a3_billing: sel.billing } });
  await call('POST', `products/${sub.item.product}`, { name: `${A3.label(sel)} · Order ${o.order_id}` }).catch(() => {});
  const fresh = await subInfo(call, sub.id).catch(() => sub);
  const order = await rpc('a3_order_patch', { p_order: o.order_id, p: { tier: sel.tier, plan_type: A3.C.plans[sel.plan].name, billing: sel.billing,
    items: A3.items(sel.tier), seats: p.seats, amount_cents: p.cents, current_period_end: fresh.current_period_end,
    config: { ...A3.config({ ...sel, os: o.config?.os || sel.os, connection: o.config?.connection || sel.connection }), ...(o.region ? { region: o.region } : {}) },
    event: { kind: 'change', from: quote.from, to: label, due_now: quote.due_now, credit: quote.credit, by } } });
  return { ...quote, done: true, order };
}
export async function pauseSub({ call, rpc, o, months, by = 'customer', nowSec = Math.floor(Date.now() / 1000) }) {
  if (!o.subscription) throw new Oops('Only subscriptions can be paused.');
  if (o.status !== 'ACTIVE') throw new Oops(o.status === 'PAUSED' ? 'It\'s already paused.' : `This order is ${String(o.status).toLowerCase()}.`);
  const n = Number(months);
  if (![1, 2, 3].includes(n)) throw new Oops('Pause for 1, 2 or 3 months.');
  const until = new Date(nowSec * 1000); until.setUTCMonth(until.getUTCMonth() + n);
  const at = Math.floor(until.getTime() / 1000);
  await call('POST', `subscriptions/${o.subscription}`, { pause_collection: { behavior: 'void', resumes_at: at } });
  return rpc('a3_order_patch', { p_order: o.order_id, p: { status: 'PAUSED', paused_until: until.toISOString(), event: { kind: 'pause', months: n, until: until.toISOString(), by } } });
}
export async function resumeSub({ call, rpc, o, by = 'customer' }) {
  if (!o.subscription || o.status !== 'PAUSED') throw new Oops("This order isn't paused.");
  await call('POST', `subscriptions/${o.subscription}`, { pause_collection: UNSET });
  return rpc('a3_order_patch', { p_order: o.order_id, p: { status: 'ACTIVE', paused_until: null, event: { kind: 'resume', by } } });
}
export async function cancelAtEnd({ call, rpc, o, undo = false, by = 'customer' }) {
  if (!o.subscription) throw new Oops('One-time orders don\'t renew, so there\'s nothing to cancel.');
  if (['CANCELLED', 'EXPIRED'].includes(o.status)) throw new Oops(`This order is already ${o.status.toLowerCase()}.`);
  const s = await call('POST', `subscriptions/${o.subscription}`, { cancel_at_period_end: undo ? 'false' : 'true' });
  const end = s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null;
  return rpc('a3_order_patch', { p_order: o.order_id, p: { cancel_at: undo ? null : end, current_period_end: end, event: { kind: undo ? 'keep' : 'cancel_at_end', by } } });
}
export async function billingPortal({ call, customer, returnUrl }) {
  if (!customer) throw new Oops('There\'s no saved card on this order.');
  try { return (await call('POST', 'billing_portal/sessions', { customer, return_url: returnUrl })).url; }
  catch (e) { throw new Oops(/configuration/i.test(e.message) ? 'Card updates aren\'t switched on yet (Stripe → Settings → Billing → Customer portal → Save).' : e.message, 503); }
}
// what a customer may see about their own order (no staff fields)
export function publicOrder(o, sub = null) {
  const pick = ['order_id', 'status', 'plan', 'tier', 'billing', 'amount', 'tax', 'seats', 'models', 'config', 'created_at', 'current_period_end', 'cancel_at', 'paused_until',
    'expires_at', 'referral_code', 'referrals', 'referral_credit', 'region', 'customer_name', 'customer_email', 'company_name', 'quote_no', 'subscription', 'stripe_customer', 'apoji'];
  const out = Object.fromEntries(pick.map(k => [k, o[k] ?? null]));
  if (o.gift) out.gift = { from_name: o.gift.from_name, message: o.gift.message, months: o.gift.months, claimed_at: o.gift.claimed_at };
  if (sub) Object.assign(out, { current_period_end: sub.current_period_end || out.current_period_end, cancel_at: sub.cancel_at_period_end ? (sub.cancel_at || sub.current_period_end) : null,
    paused_until: sub.paused_until, price: sub.item?.amount, interval: sub.item?.interval });
  const custom = !!(o.quote_no || o.source === 'custom');
  out.can = { change: !!o.subscription && !custom && o.status === 'ACTIVE' && !out.cancel_at, pause: !!o.subscription && o.status === 'ACTIVE' && !out.cancel_at,
    resume: o.status === 'PAUSED', cancel: !!o.subscription && ['ACTIVE', 'PAUSED'].includes(o.status) && !out.cancel_at, keep: !!out.cancel_at && o.status !== 'CANCELLED', card: !!o.stripe_customer };
  return out;
}

// ================================================================ 2.5
// ---------- deals: automatic offers. Price deals (percent / amount) are a Stripe coupon and don't stack with a code;
// perks (bonus models, a better chip, extra people) always apply.
export async function liveDeals(rpc) { return rpc('a3_deals_live').catch(() => []); }   // [] before aargon3-2.5.sql
export const dealFits = (d, sel) => (!d.plans?.length || d.plans.includes(sel.plan)) && (!d.tiers?.length || d.tiers.includes(sel.tier)) && (!d.billing?.length || d.billing.includes(sel.billing));
export function dealSaving(d, amount) {
  if (d.kind === 'percent') return Math.round(amount * Number(d.value)) / 100;
  if (d.kind === 'amount') return Math.min(amount, Number(d.value));
  return 0;
}
export function dealLabel(d) {
  const how = d.duration === 'forever' ? 'every payment' : d.duration === 'repeating' ? `for ${d.duration_months} months` : 'the first payment';
  if (d.kind === 'percent') return `${Number(d.value)}% off ${how}`;
  if (d.kind === 'amount') return `${A3.money(Number(d.value))} off ${how}`;
  if (d.kind === 'models') return `${(d.models || []).join(', ')} included free`;
  if (d.kind === 'chip') return `${d.chip} chip upgrade`;
  if (d.kind === 'seats') return `${Number(d.value)} extra ${Number(d.value) === 1 ? 'person' : 'people'}`;
  return d.headline || '';
}
// which deals this order gets. `promo` = a code they're using: then no price deal (one discount per order).
export function applyDeals(deals, sel, { promo = null, amount = null } = {}) {
  const fit = (deals || []).filter(d => dealFits(d, sel));
  const base = amount ?? A3.price(sel.plan, sel.tier, sel.billing).amount;
  const priceDeals = fit.filter(d => (d.kind === 'percent' || d.kind === 'amount') && d.stripe_coupon_id !== null);
  const price = promo ? null : priceDeals.sort((a, b) => dealSaving(b, base) - dealSaving(a, base))[0] || null;
  const perks = fit.filter(d => !['percent', 'amount'].includes(d.kind));
  const tierModels = new Set(A3.items(sel.tier).map(i => i.model));
  const models = [...new Set(perks.filter(d => d.kind === 'models').flatMap(d => d.models || []))].filter(m => !tierModels.has(m));
  const chips = perks.filter(d => d.kind === 'chip').map(d => d.chip).filter(c => A3.C.chips.some(x => x.id === c));
  const chip = chips.sort((a, b) => A3.C.chips.findIndex(x => x.id === b) - A3.C.chips.findIndex(x => x.id === a))[0] || null;
  const seats = perks.filter(d => d.kind === 'seats').reduce((m, d) => m + (Number(d.value) || 0), 0);
  const applied = [...(price ? [price] : []), ...perks];
  return { applied, price, models, chip, seats, saving: price ? dealSaving(price, base) : 0, after: Math.max(0, Math.round((base - (price ? dealSaving(price, base) : 0)) * 100) / 100),
    skipped: promo ? priceDeals : [] };
}
// what the public (store page, terminal) may see about a deal
export const publicDeal = d => ({ id: d.id, headline: d.headline, description: d.description || '', kind: d.kind, value: d.value != null ? Number(d.value) : null, duration: d.duration,
  duration_months: d.duration_months, models: d.models || [], chip: d.chip, plans: d.plans || [], tiers: d.tiers || [], billing: d.billing || [], ends_at: d.ends_at, featured: d.featured, label: dealLabel(d) });
function dealFields(b) {
  const kind = ['percent', 'amount', 'models', 'chip', 'seats'].includes(b.kind) ? b.kind : null;
  if (!kind) throw new Oops('Pick what the deal gives.');
  const headline = String(b.headline || '').trim().slice(0, 90), name = String(b.name || headline).trim().slice(0, 90);
  if (headline.length < 3) throw new Oops('Write the headline customers will see.');
  const value = Number(b.value);
  if (kind === 'percent' && !(value > 0 && value <= 100)) throw new Oops('Pick a percent between 1 and 100.');
  if (kind === 'amount' && !(value > 0 && value <= 10000)) throw new Oops('Pick an amount off between $1 and $10,000.');
  if (kind === 'seats' && !(Number.isInteger(value) && value > 0 && value <= 1000)) throw new Oops('Pick how many extra people (1 to 1000).');
  const allModels = Object.values(A3.C.families).flatMap(f => f.models);
  const models = kind === 'models' ? [...new Set((b.models || []).filter(m => allModels.includes(m)))] : null;
  if (kind === 'models' && !models.length) throw new Oops('Pick at least one bonus model.');
  const chip = kind === 'chip' ? A3.C.chips.find(c => c.id === b.chip && c.id !== 'No order')?.id : null;
  if (kind === 'chip' && !chip) throw new Oops('Pick the chip they get.');
  const duration = ['once', 'repeating', 'forever'].includes(b.duration) ? b.duration : 'once';
  const months = duration === 'repeating' ? Math.max(1, Math.min(36, Math.round(Number(b.duration_months) || 3))) : null;
  const when = (v, what) => { if (!v) return null; const d = new Date(v); if (isNaN(d)) throw new Oops(`That ${what} isn't a date.`); return d.toISOString(); };
  const starts = when(b.starts_at, 'start'), ends = when(b.ends_at, 'end');
  if (starts && ends && ends <= starts) throw new Oops('The deal has to end after it starts.');
  return { name, headline, description: String(b.description || '').slice(0, 300), kind, value: ['percent', 'amount', 'seats'].includes(kind) ? value : null,
    duration, duration_months: months, models, chip, plans: (b.plans || []).filter(p => A3.PLANS.includes(p)), tiers: (b.tiers || []).filter(t => A3.TIERS.includes(t)),
    billing: (b.billing || []).filter(x => ['month', 'year'].includes(x)), starts_at: starts, ends_at: ends, featured: b.featured !== false,
    limit: b.limit ? Math.max(1, Math.round(Number(b.limit))) : null };
}
const dealCoupon = (call, f) => call('POST', 'coupons', { name: f.headline.slice(0, 40), duration: f.duration, ...(f.duration_months ? { duration_in_months: f.duration_months } : {}),
  ...(f.kind === 'percent' ? { percent_off: f.value } : { amount_off: Math.round(f.value * 100), currency: A3.C.currency }), metadata: { a3_deal: '1' } });
export async function saveDeal({ call, rpc, b, by }) {
  const f = dealFields(b);
  const coupon = f.kind === 'percent' || f.kind === 'amount' ? await dealCoupon(call, f) : null;
  return rpc('a3_deal_save', { p: { ...f, stripe_coupon_id: coupon?.id || null, by } });
}
// 2.5.1: change anything about a deal. A price deal whose discount changed gets a new Stripe coupon (orders already
// placed keep the old one). Turning a deal back on needs it to be in date and under its use limit.
export async function editDeal({ call, rpc, d, b, by, nowMs = Date.now() }) {
  const has = k => Object.hasOwn(b, k), pick = (k, dk = k) => has(k) ? b[k] : d[dk];
  const f = dealFields({ kind: pick('kind'), headline: pick('headline'), name: has('headline') && !has('name') && d.name === d.headline ? b.headline : pick('name'),
    description: pick('description'), value: pick('value'), duration: pick('duration'), duration_months: pick('duration_months'), models: pick('models'), chip: pick('chip'),
    plans: pick('plans'), tiers: pick('tiers'), billing: pick('billing'), starts_at: pick('starts_at'), ends_at: pick('ends_at'), featured: pick('featured'), limit: pick('limit', 'usage_limit') });
  const active = has('active') ? !!b.active : !!d.active, turningOn = active && !d.active;
  if (active && f.ends_at && new Date(f.ends_at).getTime() <= nowMs && (turningOn || has('ends_at'))) throw new Oops('Move the end date into the future to switch the deal back on.');
  if (active && f.limit && d.used_count >= f.limit && (turningOn || has('limit'))) throw new Oops(`It's been used ${d.used_count} times. Raise the use limit above that, or clear it, to switch it back on.`);
  const priced = f.kind === 'percent' || f.kind === 'amount';
  const changed = f.kind !== d.kind || Number(f.value) !== Number(d.value) || f.duration !== (d.duration || 'once') || (f.duration_months || null) !== (d.duration_months || null);
  let coupon;   // undefined = keep the one it has
  if (priced && (changed || !d.has_coupon)) coupon = (await dealCoupon(call, f)).id;
  if (!priced) coupon = null;
  const r = await rpc('a3_deal_edit', { p_id: d.id, p: { ...f, active, ...(coupon !== undefined ? { stripe_coupon_id: coupon } : {}), by } });
  return { ...r, note: priced && changed ? 'New discount from now on. Orders already placed keep what they got.' : '' };
}

// ---------- 2.5.1: edit a code. Stripe fixes a promotion code's coupon, end date and use limit when it's made, so changing
// any of those swaps in a fresh promotion code (same code, new coupon only if the discount changed). The old one is
// switched off first and switched back on if anything fails, so the code never ends up half-changed.
export async function editPromo({ call, rpc, x, b, by, nowMs = Date.now() }) {
  if (x.old) throw new Oops('Bring this old code over first (the button at the top of Promotions), then edit it.');
  const has = k => Object.hasOwn(b, k);
  const code = has('code') ? tidyCode(b.code) : x.code;
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw new Oops('Codes are 3 to 30 letters, numbers, - or _.');
  if (/^(REF|GIFT)-/.test(code)) throw new Oops('Codes starting with REF- or GIFT- are saved for referrals and gifts.');
  const type = has('type') ? (b.type === 'fixed' ? 'fixed' : 'percentage') : x.type, value = has('value') ? Number(b.value) : Number(x.value);
  if (type === 'percentage' && !(value > 0 && value <= 100)) throw new Oops('Pick a percent between 1 and 100.');
  if (type === 'fixed' && !(value > 0 && value <= 10000)) throw new Oops('Pick an amount off between $1 and $10,000.');
  const duration = has('duration') ? (['once', 'forever', 'repeating'].includes(b.duration) ? b.duration : 'once') : (x.duration || 'once');
  const months = duration === 'repeating' ? Math.max(1, Math.min(36, Math.round(Number(has('duration_months') ? b.duration_months : x.duration_months) || 3))) : null;
  const plans = has('plans') ? (b.plans || []).filter(p => A3.PLANS.includes(p)) : (x.plans || []), tiers = has('tiers') ? (b.tiers || []).filter(t => A3.TIERS.includes(t)) : (x.tiers || []);
  const min_total = has('min_total') ? Math.max(0, Number(b.min_total) || 0) : Number(x.min_total) || 0;
  const date = (v, what) => { if (!v) return null; const d = new Date(v); if (isNaN(d)) throw new Oops(`That ${what} isn't a date.`); return d.toISOString(); };
  const starts = has('starts') ? date(b.starts, 'start date') : x.starts, ends = has('ends') ? date(b.ends, 'end date') : (x.ends || null);
  if (starts && ends && new Date(ends) <= new Date(starts)) throw new Oops('The code has to end after it starts.');
  const limit = has('limit') ? (b.limit ? Math.max(1, Math.round(Number(b.limit))) : null) : (x.limit || null);
  const used = Number(x.used) || 0, active = has('active') ? !!b.active : !!x.active, turningOn = active && !x.active;
  const expired = !!ends && new Date(ends).getTime() <= nowMs, usedUp = !!limit && used >= limit;
  if (active && expired && (turningOn || has('ends'))) throw new Oops('Move the end date into the future to switch the code back on.');
  if (active && usedUp && (turningOn || has('limit'))) throw new Oops(`It's been used ${used} times. Raise the use limit above that, or clear it, to switch it back on.`);
  const discountChanged = type !== x.type || value !== Number(x.value) || duration !== (x.duration || 'once') || (months || null) !== (x.duration_months || null);
  const t = v => v ? new Date(v).getTime() : null;
  const stripeChanged = discountChanged || code !== x.code || t(ends) !== t(x.ends) || limit !== (x.limit || null) || turningOn;
  const autoLabel = !x.description || x.description === discountLabel(x);
  const description = has('description') && String(b.description || '').trim() ? String(b.description).trim().slice(0, 200)
    : discountChanged && autoLabel ? discountLabel({ type, value, duration, duration_months: months }) : x.description;
  let promoId = x.stripe_promo_id, couponId, made = null;
  const setOld = on => x.stripe_promo_id ? call('POST', `promotion_codes/${x.stripe_promo_id}`, { active: on ? 'true' : 'false' }).catch(() => {}) : null;
  if (!active && x.active) await setOld(false);
  else if (active && !expired && !usedUp && stripeChanged) {
    couponId = discountChanged ? null : (await call('GET', `promotion_codes/${x.stripe_promo_id}`).catch(() => null))?.coupon?.id;
    if (!couponId) couponId = (await call('POST', 'coupons', { name: code, duration, ...(months ? { duration_in_months: months } : {}),
      ...(type === 'percentage' ? { percent_off: value } : { amount_off: Math.round(value * 100), currency: A3.C.currency }), metadata: { a3: '1' } })).id;
    await setOld(false);
    try {
      made = await call('POST', 'promotion_codes', { coupon: couponId, code, ...(limit ? { max_redemptions: limit - used } : {}),
        ...(ends ? { expires_at: Math.floor(t(ends) / 1000) } : {}), metadata: { a3: '1', a3_id: String(x.id) } });
    } catch (e) {
      if (x.active) await setOld(true);
      throw /already exists/i.test(e.message) ? new Oops(`Stripe already has a working code called ${code}. Pick another code.`) : e;
    }
    promoId = made.id;
  }
  try {
    const r = await rpc('a3_promo_edit', { p_id: x.id, p: { code, type, value, duration, duration_months: months, description, plans, tiers, min_total, starts, ends, limit, active,
      ...(couponId ? { stripe_coupon_id: couponId } : {}), ...(promoId !== x.stripe_promo_id ? { stripe_promo_id: promoId } : {}), by } });
    return { ...r, note: discountChanged && (x.duration === 'forever' || x.duration === 'repeating') && used ? 'Customers who already used it keep their old discount.' : '' };
  } catch (e) {   // the database said no (e.g. the code is taken): put Stripe back how it was
    if (made) { await call('POST', `promotion_codes/${made.id}`, { active: 'false' }).catch(() => {}); if (x.active) await setOld(true); }
    throw e;
  }
}

// ---------- codes that fit an order (the "find a code" panel on New sale)
export async function codesFor({ rpc, sel }) {
  const amount = A3.price(sel.plan, sel.tier, sel.billing).amount;
  const all = await rpc('a3_promos');
  return all.filter(x => x.live && x.stripe_promo_id).map(x => {
    let why = null;
    if (x.plans?.length && !x.plans.includes(sel.plan)) why = `${A3.C.plans[x.plans[0]]?.name || x.plans[0]}${x.plans.length > 1 ? ' etc.' : ''} only`;
    else if (x.tiers?.length && !x.tiers.includes(sel.tier)) why = `${x.tiers.map(t => A3.C.tiers[t]?.name || t).join('/')} only`;
    else if (Number(x.min_total) > 0 && amount < Number(x.min_total)) why = `needs ${A3.money(Number(x.min_total))}+`;
    return { code: x.code, label: discountLabel(x), description: x.description, ends: x.ends, left: x.limit ? x.limit - x.used : null, fits: !why, why, after: discounted(amount, x), batch: x.batch };
  }).sort((a, b) => (b.fits - a.fits) || (a.after - b.after));
}

// ---------- the old aARgon3 codes: tidy them up and give them a Stripe coupon + promotion code
const tidyCode = c => String(c || '').toUpperCase().trim().replace(/\s+/g, '-').replace(/[^A-Z0-9_-]/g, '').slice(0, 30);
function oldList(v, keys, names) {
  const out = [];
  for (const raw of v || []) {
    const t = String(raw).trim().toLowerCase();
    const k = keys.find(x => x === t) || keys.find(x => names(x).toLowerCase() === t);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}
export async function upgradeOldCode({ call, rpc, x, taken = new Set(), nowMs = Date.now() }) {
  let code = tidyCode(x.code);
  if (code.length < 3) code = `OLD-${x.id}`;
  if (taken.has(code) && code !== x.code) code = `${code.slice(0, 26)}-OLD`;
  const type = /fix|amount|dollar|flat/i.test(x.type) ? 'fixed' : 'percentage', value = Number(x.value);
  // old codes listed plans and tiers by name, sometimes mixed together
  const both = [...(x.plans || []), ...(x.tiers || [])];
  const plans = oldList(both, A3.PLANS, k => A3.C.plans[k].name), tiers = oldList(both, A3.TIERS, k => A3.C.tiers[k].name);
  const base = { code, type, value, plans, tiers, duration: x.duration || 'once' };
  const ended = x.ends && new Date(x.ends).getTime() <= nowMs, usedUp = x.limit && x.used >= x.limit;
  if (!(value > 0) || (type === 'percentage' && value > 100)) return rpc('a3_promo_upgrade', { p_id: x.id, p: { ...base, active: false, ended_reason: 'invalid' } }).then(r => ({ ...r, result: 'switched off: the discount amount was not valid' }));
  if (ended || usedUp || !x.active) return rpc('a3_promo_upgrade', { p_id: x.id, p: { ...base, active: false, ended_reason: ended ? 'expired' : usedUp ? 'used up' : 'manual' } })
    .then(r => ({ ...r, result: ended ? 'already expired: kept for the records, switched off' : usedUp ? 'already used up: switched off' : 'was off: tidied, left off' }));
  const coupon = await call('POST', 'coupons', { name: code, duration: base.duration === 'repeating' ? 'repeating' : base.duration === 'forever' ? 'forever' : 'once',
    ...(base.duration === 'repeating' ? { duration_in_months: x.duration_months || 3 } : {}),
    ...(type === 'percentage' ? { percent_off: value } : { amount_off: Math.round(value * 100), currency: A3.C.currency }), metadata: { a3: '1', a3_old: String(x.id) } });
  let promo;
  try {
    promo = await call('POST', 'promotion_codes', { coupon: coupon.id, code, ...(x.limit ? { max_redemptions: Math.max(1, x.limit - (x.used || 0)) } : {}),
      ...(x.ends ? { expires_at: Math.floor(new Date(x.ends).getTime() / 1000) } : {}), metadata: { a3: '1' } });
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
    promo = (await call('GET', `promotion_codes?${qs({ code, active: 'true', limit: 1 })}`)).data?.[0];
    if (!promo) throw e;
  }
  const r = await rpc('a3_promo_upgrade', { p_id: x.id, p: { ...base, description: x.description || discountLabel({ type, value, duration: base.duration, duration_months: x.duration_months }),
    stripe_coupon_id: coupon.id, stripe_promo_id: promo.id, active: true } });
  return { ...r, result: code !== x.code ? `works now (renamed from "${x.code}")` : 'works now' };
}

// ---------- a batch of codes from the generator: one coupon, one promotion code each
export async function makeCodes({ call, rpc, b, by }) {
  const prefix = tidyCode(b.prefix || b.code).replace(/-+$/, '');
  const count = Math.max(1, Math.min(50, Math.round(Number(b.count) || 1)));
  if (prefix.length < 3 || prefix.length > (count > 1 ? 24 : 30)) throw new Oops(count > 1 ? 'The start of the code should be 3 to 24 letters or numbers.' : 'Codes are 3 to 30 letters, numbers, - or _.');
  const type = b.type === 'fixed' ? 'fixed' : 'percentage', value = Number(b.value);
  if (type === 'percentage' && !(value > 0 && value <= 100)) throw new Oops('Pick a percent between 1 and 100.');
  if (type === 'fixed' && !(value > 0 && value <= 10000)) throw new Oops('Pick an amount off between $1 and $10,000.');
  const duration = ['once', 'forever', 'repeating'].includes(b.duration) ? b.duration : 'once';
  const months = duration === 'repeating' ? Math.max(1, Math.min(36, Math.round(Number(b.duration_months) || 3))) : null;
  const plans = (b.plans || []).filter(p => A3.PLANS.includes(p)), tiers = (b.tiers || []).filter(t => A3.TIERS.includes(t));
  const iso = v => { if (!v) return null; const d = new Date(v); if (isNaN(d)) throw new Oops("That date doesn't look right."); return d.toISOString(); };
  const starts = iso(b.starts), ends = iso(b.ends);
  if (ends && new Date(ends) <= new Date()) throw new Oops('The end date has to be in the future.');
  const each = count > 1 ? Math.max(1, Math.round(Number(b.limit_each) || 1)) : (b.limit ? Math.max(1, Math.round(Number(b.limit))) : null);
  const existing = new Set((await rpc('a3_promos')).map(x => x.code));
  const codes = [];
  if (count === 1) { if (existing.has(prefix)) throw new Oops('That code already exists.'); codes.push(prefix); }
  else while (codes.length < count) { const c = `${prefix}-${A3.orderId(randomBytes).replace('-', '').slice(0, 4)}`; if (!existing.has(c) && !codes.includes(c)) codes.push(c); }
  const coupon = await call('POST', 'coupons', { name: prefix.slice(0, 40), duration, ...(months ? { duration_in_months: months } : {}),
    ...(type === 'percentage' ? { percent_off: value } : { amount_off: Math.round(value * 100), currency: A3.C.currency }), metadata: { a3: '1', a3_batch: prefix } });
  const description = String(b.description || '').slice(0, 200) || discountLabel({ type, value, duration, duration_months: months });
  const out = [];
  for (const code of codes) {
    const pc = await call('POST', 'promotion_codes', { coupon: coupon.id, code, ...(each ? { max_redemptions: each } : {}),
      ...(ends ? { expires_at: Math.floor(new Date(ends).getTime() / 1000) } : {}), metadata: { a3: '1', a3_batch: prefix } });
    out.push(await rpc('a3_promo_save', { p: { code, type, value, duration, duration_months: months, description, plans, tiers, min_total: Number(b.min_total) || 0,
      starts, ends, limit: each, stripe_coupon_id: coupon.id, stripe_promo_id: pc.id, created_by: by, batch: count > 1 ? prefix : null } }));
  }
  return out;
}

// ---------- portal extras: the next bill, account credit, a code on an existing plan
export async function nextBill(call, o) {
  if (!o.subscription || !o.customer) return null;
  const [up, cus] = await Promise.all([call('GET', `invoices/upcoming?${qs({ customer: o.customer, subscription: o.subscription })}`).catch(() => null),
    call('GET', `customers/${encodeURIComponent(o.customer)}`).catch(() => null)]);
  const credit = cus && cus.balance < 0 ? -cus.balance / 100 : 0;
  if (!up) return { credit };
  const discount = (up.total_discount_amounts || []).reduce((m, d) => m + (d.amount || 0), 0) / 100;
  return { amount: (up.amount_due ?? up.total ?? 0) / 100, subtotal: (up.subtotal ?? 0) / 100, tax: (up.tax || 0) / 100, discount, credit,
    credit_used: up.starting_balance < 0 ? Math.min(-up.starting_balance, up.total || 0) / 100 : 0,
    date: up.next_payment_attempt ? new Date(up.next_payment_attempt * 1000).toISOString() : up.period_end ? new Date(up.period_end * 1000).toISOString() : null };
}
export async function codeOnPlan({ call, rpc, o, code, by = 'customer' }) {
  if (!o.subscription) throw new Oops('Codes can be added to plans that renew. For a one-time order, use the code on your next order.');
  if (!['ACTIVE', 'PAUSED'].includes(o.status)) throw new Oops(`This order is ${String(o.status).toLowerCase()}.`);
  if (/^REF-/i.test(String(code))) throw new Oops('Referral codes are for new orders. Share yours with a friend instead!');
  const key = Object.keys(A3.C.plans).find(k => A3.C.plans[k].name === o.plan) || 'personal';
  const sel = A3.selection({ plan: key, tier: o.tier, billing: o.billing === 'year' ? 'year' : 'month' });
  const x = await checkPromo({ rpc, code, sel, amount: A3.price(sel.plan, sel.tier, sel.billing).amount });
  await call('POST', `subscriptions/${o.subscription}`, { promotion_code: x.stripe_promo_id });
  await rpc('a3_order_patch', { p_order: o.order_id, p: { event: { kind: 'code', code: x.code, label: x.label, by } } });
  return { code: x.code, label: x.label };
}

// ================================================================ 2.6 Apoji-wide
// ---------- link a Nexus account to an order: the customer makes a one-time code in Nexus (Settings → Profile → Link code),
// we trade it with Nexus for the public look of that account (picture, frame, name style; never an email or id) and keep a copy.
const APOJI_KEYS = ['username', 'nickname', 'display_name', 'avatar_url', 'frame', 'font', 'color', 'ptheme', 'name_a', 'name_b', 'pframe', 'pronouns', 'owner'];
export function apojiLook(p = {}) {
  const out = {};
  for (const k of APOJI_KEYS) if (p[k] != null && p[k] !== '') out[k] = typeof p[k] === 'string' ? p[k].slice(0, 300) : p[k];
  if (out.avatar_url && !/^https:\/\/[a-z0-9.-]+\.supabase\.co\/storage\/v1\/object\/public\//i.test(out.avatar_url)) delete out.avatar_url;   // only Nexus's own picture storage
  if (out.owner != null) out.owner = out.owner === true;
  return out;
}
export async function nexusRpc(env, fetchImpl, fn, args = {}, token = null) {
  const url = (env.NEXUS_URL || NEXUS_URL).replace(/\/$/, ''), key = env.NEXUS_KEY || NEXUS_KEY;
  let res;
  try { res = await fetchImpl(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${token || key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) }); }
  catch { throw new Oops("Can't reach Nexus right now. Try again in a minute.", 503); }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Oops(/function|schema cache/i.test(data?.message || '') ? 'Linking Nexus accounts isn\'t switched on yet.' : (data?.message || `Nexus error (${res.status}).`), 502);
  return data;
}
export async function linkApoji({ env, fetchImpl, rpc, o, code }) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 8) throw new Oops('Link codes are 8 letters and numbers. Make one in Nexus: Settings → Profile → Link code.');
  const r = await nexusRpc(env, fetchImpl, 'apoji_public_profile', { p_code: c, p_app: 'aARgon3' });
  if (!r?.ok || !r.profile) throw new Oops("That code didn't work. Each code works once, for 15 minutes: make a new one in Nexus (Settings → Profile → Link code).", 404);
  const look = apojiLook(r.profile);
  if (!look.username) throw new Oops('That Nexus account needs a username first (Nexus → Settings → Profile).');
  return rpc('a3_order_apoji', { p_order: o.order_id, p: look });
}
