// Shared by the aARgon3 Edge Functions (checkout, stripe-webhook, staff). Plain JavaScript with no imports, so the
// same file runs in Supabase (Deno) and in the tests (Node). Everything that needs the outside world (fetch, env,
// random bytes, the clock) is passed in, which is what lets the tests swap Stripe and Supabase for fakes.
import { A3 } from './catalog.mjs';

export { A3 };

// ---------- HTTP
// The store and the terminal on GitHub Pages, the desktop app, and local testing.
const ORIGINS = [/^https:\/\/apojidelegraphics\.github\.io$/, /^aargon3:\/\/app$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
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

// A Stripe Checkout page for a subscription. The order number is made now, so it's printed on Stripe's receipt and
// invoices; the order itself is only written once Stripe says it's paid (fulfill below).
export async function startCheckout({ call, siteUrl, sel, staff = null }) {
  const p = A3.price(sel.plan, sel.tier, sel.billing);
  if (p.quote) throw new Oops(`Enterprise is quoted for your team. Email ${A3.C.contactEmail} and we'll set it up.`);
  const orderId = newOrderId();
  const meta = { a3_order: orderId, a3_plan: sel.plan, a3_tier: sel.tier, a3_billing: sel.billing, a3_os: sel.os, a3_connection: sel.connection,
    a3_source: staff ? 'terminal' : 'web', a3_staff: staff?.id, a3_operator: staff?.name, a3_shift: staff?.shiftId };
  const site = siteUrl.replace(/\/$/, '');
  const session = await call('POST', 'checkout/sessions', {
    mode: 'subscription',
    line_items: { 0: { quantity: 1, price_data: { currency: A3.C.currency, unit_amount: p.cents, recurring: { interval: p.interval },
      product_data: { name: `${A3.label(sel)} · Order ${orderId}`, description: A3.describe(sel) } } } },
    customer_email: sel.email || undefined,
    allow_promotion_codes: 'true',
    billing_address_collection: 'auto',
    success_url: `${site}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: staff ? `${site}/success.html?cancelled=1` : `${site}/#plans`,
    metadata: meta,
    subscription_data: { description: `aARgon3 order ${orderId}`, metadata: meta },
    custom_text: { submit: { message: `Your order number is ${orderId}. By subscribing you agree to the aARgon3 Terms of Sale: ${site}/terms/` } }
  });
  return { url: session.url, session_id: session.id, order_id: orderId, amount: p.amount, interval: p.interval };
}

// Writes the order for a paid Checkout Session (from the webhook, or from the thank-you page if the webhook is late).
// Safe to call more than once: the database ignores a session it has already seen.
export async function fulfill({ rpc, session }) {
  const paid = session.status === 'complete' && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required');
  if (!paid) return null;
  const m = session.metadata || {};
  const sel = A3.selection({ plan: m.a3_plan, tier: m.a3_tier, billing: m.a3_billing, os: m.a3_os, connection: m.a3_connection });
  const r = await rpc('a3_record_order', { p: {
    order_id: m.a3_order || newOrderId(), stripe_session_id: session.id,
    stripe_subscription_id: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id,
    stripe_customer_id: typeof session.customer === 'string' ? session.customer : session.customer?.id,
    plan_type: A3.C.plans[sel.plan].name, tier: sel.tier, billing: sel.billing, config: A3.config(sel), items: A3.items(sel.tier),
    amount_cents: session.amount_total ?? 0, currency: session.currency || A3.C.currency,
    customer_name: session.customer_details?.name || '', customer_email: session.customer_details?.email || session.customer_email || '',
    source: m.a3_source || 'web', staff_user_id: m.a3_staff || null, operator: m.a3_operator || null, shift_id: m.a3_shift || null,
    payment_method: 'card' } });
  return r;
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
