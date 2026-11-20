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
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out); else out.append(key, String(v));
  }
  return out;
}
export function stripe(env, fetchImpl = fetch) {
  const key = env.STRIPE_SECRET_KEY;
  return async function call(method, path, body) {
    if (!key) throw new Oops('Payments aren\'t set up yet (STRIPE_SECRET_KEY is missing).', 503);
    const res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
      method, headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_VERSION, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? form(body).toString() : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Oops(data?.error?.message || `Stripe error (${res.status}).`, 502);
    return data;
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
function toMeta({ orderId, sel, customer = {}, staff = null, custom = null, promo = null }) {
  const m = { a3_order: orderId, a3_plan: sel.plan, a3_tier: sel.tier, a3_billing: sel.billing, a3_os: sel.os, a3_connection: sel.connection,
    a3_source: custom ? 'custom' : staff ? 'terminal' : 'web', a3_staff: staff?.id, a3_operator: staff?.name, a3_shift: staff?.shiftId,
    a3_promo: promo?.code, a3_quote: custom?.quote_no, a3_seats: custom?.seats, a3_chip: custom?.chip,
    a3_models: custom?.models?.length ? custom.models.join(',').slice(0, 490) : undefined, a3_interval: custom?.interval };
  for (const k of CUSTOMER_KEYS) if (customer[k]) m['a3_c_' + k] = String(customer[k]).slice(0, 490);
  for (const k of Object.keys(m)) if (m[k] === undefined || m[k] === null || m[k] === '') delete m[k];
  return m;
}
function fromMeta(m = {}) {
  const customer = {}; for (const k of CUSTOMER_KEYS) if (m['a3_c_' + k]) customer[k] = m['a3_c_' + k];
  customer.name = [customer.first, customer.last].filter(Boolean).join(' ');
  return { customer, seats: m.a3_seats ? Number(m.a3_seats) : null, chip: m.a3_chip || null, models: m.a3_models ? m.a3_models.split(',').filter(Boolean) : null,
    quote_no: m.a3_quote || null, promo: m.a3_promo || null, interval: m.a3_interval || null };
}

// The row a3_record_order writes, from Stripe metadata plus what Stripe tells us about the payment.
function orderRecord(m, extra) {
  const x = fromMeta(m);
  const sel = A3.selection({ plan: m.a3_plan, tier: m.a3_tier, billing: m.a3_billing, os: m.a3_os, connection: m.a3_connection });
  const config = { ...A3.config(sel), ...(x.chip ? { chip: x.chip } : {}), ...(x.seats ? { seats: x.seats } : {}), ...(x.interval === 'once' ? { billing: 'once' } : {}) };
  const items = x.models ? x.models.map(model => ({ model, price: 0, family: Object.keys(A3.C.families).find(f => A3.C.families[f].models.includes(model)) || 'custom' })) : A3.items(sel.tier);
  const c = x.customer;
  return { ...extra, order_id: m.a3_order || newOrderId(), plan_type: A3.C.plans[sel.plan].name, tier: sel.tier, billing: x.interval === 'once' ? 'once' : sel.billing,
    config, items, seats: x.seats || A3.price(sel.plan, sel.tier, 'month').seats, source: m.a3_source || 'web', staff_user_id: m.a3_staff || null,
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
export async function startCheckout({ call, siteUrl, sel, customer = {}, staff = null, custom = null, promo = null }) {
  const p = A3.price(sel.plan, sel.tier, sel.billing);
  if (p.quote && !custom) throw new Oops(`Enterprise is quoted for your team. Email ${A3.C.contactEmail} and we'll set it up.`);
  const orderId = newOrderId(), interval = custom?.interval || p.interval, cents = custom ? custom.amount_cents : p.cents;
  if (!Number.isInteger(cents) || cents < 50) throw new Oops('The price has to be at least $0.50.');
  const meta = toMeta({ orderId, sel, customer, staff, custom, promo });
  const site = siteUrl.replace(/\/$/, '');
  const seats = custom?.seats || p.seats;
  const name = `${A3.label(sel)}${custom?.seats ? ` (${custom.seats} people)` : ''} · Order ${orderId}`;
  const desc = custom ? `${A3.C.tiers[sel.tier].tagline} ${seats ? `For ${seats} ${seats === 1 ? 'person' : 'people'}. ` : ''}${sel.os} on ${custom.chip || A3.C.tiers[sel.tier].chip}.${custom.quote_no ? ` Quote ${custom.quote_no}.` : ''}`
    : A3.describe(sel);
  const once = interval === 'once';
  const session = await call('POST', 'checkout/sessions', {
    mode: once ? 'payment' : 'subscription',
    line_items: { 0: { quantity: 1, price_data: { currency: A3.C.currency, unit_amount: cents, ...(once ? {} : { recurring: { interval } }),
      product_data: { name, description: desc.slice(0, 500) } } } },
    customer_email: customer.email || sel.email || undefined,
    ...(promo ? { discounts: { 0: { promotion_code: promo.stripe_promo_id } } } : {}),
    billing_address_collection: 'auto',
    ...(once ? { customer_creation: 'always', invoice_creation: { enabled: 'true', invoice_data: { metadata: meta, description: `aARgon3 order ${orderId}` } }, payment_intent_data: { metadata: meta } }
             : { subscription_data: { description: `aARgon3 order ${orderId}`, metadata: meta } }),
    success_url: `${site}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: staff ? `${site}/success.html?cancelled=1` : `${site}/#plans`,
    metadata: meta,
    custom_text: { submit: { message: `Your order number is ${orderId}. By paying you agree to the aARgon3 Terms of Sale: ${site}/terms/` } }
  });
  return { url: session.url, session_id: session.id, order_id: orderId, amount: cents / 100, interval };
}

// Writes the order for a paid Checkout Session (from the webhook, or from the thank-you page if the webhook is late).
// Safe to call more than once: the database ignores a session it has already seen.
export async function fulfill({ rpc, session }) {
  const paid = session.status === 'complete' && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required');
  if (!paid) return null;
  const m = session.metadata || {};
  if (!m.a3_plan) return null;
  return rpc('a3_record_order', { p: orderRecord(m, {
    stripe_session_id: session.id, stripe_subscription_id: sid(session.subscription), stripe_customer_id: sid(session.customer),
    stripe_invoice_id: sid(session.invoice), first_invoice_id: sid(session.invoice), amount_cents: session.amount_total ?? 0, discount_cents: session.total_details?.amount_discount || 0,
    currency: session.currency || A3.C.currency, customer_name: session.customer_details?.name || '', customer_email: session.customer_details?.email || session.customer_email || '',
    customer_phone: session.customer_details?.phone || '' }) });
}

// Thank-you page / terminal: is this session's order ready? Checks Stripe directly if the webhook hasn't run yet.
export async function sessionStatus({ rpc, call, sessionId }) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(String(sessionId || ''))) throw new Oops('That checkout link isn\'t valid.');
  let order = await rpc('a3_order_by_session', { p_session: sessionId });
  if (order) return { ready: true, order };
  const session = await call('GET', `checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (session.status === 'expired') return { ready: false, state: 'expired' };
  if (session.status !== 'complete') return { ready: false, state: 'open' };
  if (session.payment_status === 'unpaid') return { ready: false, state: 'processing' };
  await fulfill({ rpc, session });
  order = await rpc('a3_order_by_session', { p_session: sessionId });
  return order ? { ready: true, order } : { ready: false, state: 'processing' };
}

// ---------- invoices (custom orders and Enterprise quotes)
// Stripe emails the customer an invoice with a "Pay" link. Recurring quotes become a subscription billed by invoice.
export async function sendInvoice({ call, sel, customer, custom, staff, daysUntilDue = 30 }) {
  const orderId = newOrderId(), meta = toMeta({ orderId, sel, customer, staff, custom });
  const email = customer.billing_email || customer.email;
  if (!email) throw new Oops('Add the customer\'s email (or a billing email) to send an invoice.');
  const cus = await call('POST', 'customers', { email, name: customer.company || customer.name || undefined, phone: customer.phone || undefined,
    description: customer.company ? `${customer.name} · ${customer.company}` : undefined, metadata: { a3_quote: custom.quote_no } });
  const name = `${A3.label(sel)}${custom.seats ? ` (${custom.seats} people)` : ''} · Order ${orderId}`;
  const days = Math.min(Math.max(Number(daysUntilDue) || 30, 1), 90);
  let invoice;
  if (custom.interval === 'once') {
    await call('POST', 'invoiceitems', { customer: cus.id, amount: custom.amount_cents, currency: A3.C.currency, description: name, metadata: meta });
    invoice = await call('POST', 'invoices', { customer: cus.id, collection_method: 'send_invoice', days_until_due: days, metadata: meta,
      pending_invoice_items_behavior: 'include', description: `aARgon3 order ${orderId}${custom.quote_no ? ` · Quote ${custom.quote_no}` : ''}` });
  } else {
    const product = await call('POST', 'products', { name, metadata: { a3_quote: custom.quote_no } });
    const sub = await call('POST', 'subscriptions', { customer: cus.id, collection_method: 'send_invoice', days_until_due: days, metadata: meta,
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
    return { order: r?.order_id };
  }
  if (!subId) return { ignored: 'one-time checkout invoice' };
  // first invoices of checkout subscriptions are already counted by fulfill (same invoice id)
  return rpc('a3_record_payment', { p_invoice: invoice.id, p_subscription: subId, p_amount_cents: amount, p_kind: first ? 'first' : 'renewal' });
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
export async function checkPromo({ rpc, code, sel, amount }) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const x = await rpc('a3_promo', { p_code: c });
  if (!x || !x.live || !x.stripe_promo_id) throw new Oops(`"${c}" isn't a working code.`);
  if (x.plans?.length && !x.plans.includes(sel.plan)) throw new Oops(`${c} doesn't work on the ${A3.C.plans[sel.plan].name} plan.`);
  if (x.tiers?.length && !x.tiers.includes(sel.tier)) throw new Oops(`${c} works on ${x.tiers.map(t => A3.C.tiers[t]?.name || t).join(' and ')} only.`);
  if (Number(x.min_total) > 0 && amount < Number(x.min_total)) throw new Oops(`${c} needs an order of ${A3.money(Number(x.min_total))} or more.`);
  return { ...x, label: discountLabel(x), after: discounted(amount, x) };
}

// Store open? (settings → store)
export async function storeInfo(rpc) {
  try { const s = await rpc('a3_settings'); return { open: s?.store?.open !== false, message: s?.store?.message || '', business: s?.business || {} }; }
  catch { return { open: true, message: '', business: {} }; }   // before aargon3-2.1.sql
}
