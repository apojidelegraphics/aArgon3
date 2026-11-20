// POST /functions/v1/checkout — the public store.
//   { action: 'start', plan, tier, billing, os, connection, customer: {first, last, email, …}, promo }  → { url }   (send the browser to Stripe)
//   { action: 'status', session_id }                     → { ready, order }    (the thank-you page)
//   { action: 'promo', code, plan, tier, billing }       → { label, after }    ("Apply" on a promo code)
//   { action: 'info' }                                   → { open, message }   (is the store taking orders?)
// Needs secrets STRIPE_SECRET_KEY and SITE_URL (https://apojidelegraphics.github.io/aArgon3).
import { A3, cors, json, Oops, db, stripe, startCheckout, sessionStatus, checkPromo, storeInfo } from '../_shared/lib.mjs';

export function handler(env, fetchImpl = fetch) {
  const rpc = db(env, fetchImpl), call = stripe(env, fetchImpl);
  return async function (req) {
    const h = cors(req);
    if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405, h);
    try {
      const b = await req.json().catch(() => ({}));
      if (b.action === 'info') { const i = await storeInfo(rpc); return json({ open: i.open, message: i.message }, 200, h); }
      if (b.action === 'start') {
        const info = await storeInfo(rpc);
        if (!info.open) throw new Oops(info.message || 'The store is closed for now. Please check back soon.', 409);
        const sel = A3.selection(b);
        const customer = A3.customer(sel.plan, b.customer || { email: b.email });
        const p = A3.price(sel.plan, sel.tier, sel.billing);
        const promo = b.promo ? await checkPromo({ rpc, code: b.promo, sel, amount: p.amount }) : null;
        const r = await startCheckout({ call, siteUrl: env.SITE_URL || 'https://apojidelegraphics.github.io/aArgon3', sel, customer, promo });
        return json({ url: r.url }, 200, h);
      }
      if (b.action === 'promo') {
        const sel = A3.selection(b), p = A3.price(sel.plan, sel.tier, sel.billing);
        const x = await checkPromo({ rpc, code: b.code, sel, amount: p.amount });
        if (!x) throw new Oops('Enter a code.');
        return json({ code: x.code, label: x.label, after: x.after, before: p.amount, duration: x.duration }, 200, h);
      }
      if (b.action === 'status') return json(await sessionStatus({ rpc, call, sessionId: b.session_id }), 200, h);
      throw new Oops('Unknown action.');
    } catch (e) {
      const status = e instanceof Oops ? e.status : 400;
      if (status >= 500) console.error('[checkout]', e);
      return json({ error: e.message || 'Something went wrong.' }, status, h);
    }
  };
}
