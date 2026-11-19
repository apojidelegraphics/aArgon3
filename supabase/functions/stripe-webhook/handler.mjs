// POST /functions/v1/stripe-webhook — Stripe tells us about payments and subscriptions.
// In Stripe: Developers → Webhooks → Add endpoint → this URL, with these events:
//   checkout.session.completed, checkout.session.async_payment_succeeded, customer.subscription.updated, customer.subscription.deleted
// Needs secrets STRIPE_WEBHOOK_SECRET (whsec_…) and STRIPE_SECRET_KEY.
import { json, Oops, db, verifyStripeSignature, fulfill } from '../_shared/lib.mjs';

export function handler(env, fetchImpl = fetch, now = () => Date.now()) {
  const rpc = db(env, fetchImpl);
  return async function (req) {
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    let event;
    try { event = await verifyStripeSignature(await req.text(), req.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET, Math.floor(now() / 1000)); }
    catch (e) { return json({ error: e.message }, e.status || 400); }
    try {
      const o = event.data?.object || {};
      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded': {
          if ((o.metadata || {}).a3_plan) { const r = await fulfill({ rpc, session: o }); return json({ received: true, order: r?.order_id || null }); }
          return json({ received: true, ignored: 'not an aARgon3 checkout' });
        }
        case 'customer.subscription.deleted':
          await rpc('a3_set_status', { p_order: null, p_subscription: o.id, p_status: 'CANCELLED' });
          return json({ received: true });
        case 'customer.subscription.updated': {
          // canceled / unpaid → Nexus stops honoring the order; back to active (e.g. a card was fixed) → it works again
          const s = o.status;
          const status = ['canceled', 'unpaid', 'incomplete_expired'].includes(s) ? 'CANCELLED' : ['active', 'trialing'].includes(s) ? 'ACTIVE' : null;
          if (status) await rpc('a3_set_status', { p_order: null, p_subscription: o.id, p_status: status });
          return json({ received: true });
        }
        default: return json({ received: true, ignored: event.type });
      }
    } catch (e) {
      console.error('[stripe-webhook]', event?.type, e);
      return json({ error: e.message }, 500);   // Stripe retries on 5xx
    }
  };
}
