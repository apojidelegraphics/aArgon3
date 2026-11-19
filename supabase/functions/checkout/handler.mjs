// POST /functions/v1/checkout — the public store.
//   { action: 'start', plan, tier, billing, os, connection, email }  → { url }   (send the browser to Stripe)
//   { action: 'status', session_id }                                 → { ready, order }   (the thank-you page)
// Needs secrets STRIPE_SECRET_KEY and SITE_URL (https://apojidelegraphics.github.io/aArgon3).
import { A3, cors, json, Oops, db, stripe, startCheckout, sessionStatus } from '../_shared/lib.mjs';

export function handler(env, fetchImpl = fetch) {
  const rpc = db(env, fetchImpl), call = stripe(env, fetchImpl);
  return async function (req) {
    const h = cors(req);
    if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405, h);
    try {
      const b = await req.json().catch(() => ({}));
      if (b.action === 'start') {
        const sel = A3.selection(b);
        const r = await startCheckout({ call, siteUrl: env.SITE_URL || 'https://apojidelegraphics.github.io/aArgon3', sel });
        return json({ url: r.url }, 200, h);
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
