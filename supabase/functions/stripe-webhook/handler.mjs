// POST /functions/v1/stripe-webhook — Stripe tells us about payments and subscriptions.
// In Stripe: Developers → Webhooks → Add endpoint → this URL, with these events:
//   checkout.session.completed, checkout.session.async_payment_succeeded, customer.subscription.updated, customer.subscription.deleted,
//   invoice.paid (2.1: invoiced quotes and renewals), checkout.session.expired (2.4: "remind me" emails)
// Needs secrets STRIPE_WEBHOOK_SECRET (whsec_…) and STRIPE_SECRET_KEY.
import { A3, json, Oops, db, stripe, verifyStripeSignature, fulfill, invoicePaid, mailer, planLink } from '../_shared/lib.mjs';

export function handler(env, fetchImpl = fetch, now = () => Date.now()) {
  const rpc = db(env, fetchImpl), call = stripe(env, fetchImpl);
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
          if ((o.metadata || {}).a3_plan) {
            const s = await rpc('a3_settings').catch(() => ({}));
            const r = await fulfill({ rpc, session: o, call, mail: mailer(env, fetchImpl, s) });
            return json({ received: true, order: r?.order_id || null });
          }
          return json({ received: true, ignored: 'not an aARgon3 checkout' });
        }
        case 'invoice.paid':
          return json({ received: true, ...(await invoicePaid({ rpc, call, invoice: o })) });
        case 'customer.subscription.deleted':
          await rpc('a3_set_status', { p_order: null, p_subscription: o.id, p_status: 'CANCELLED' });
          return json({ received: true });
        case 'customer.subscription.updated': {
          // canceled / unpaid → Nexus stops honoring the order; back to active (e.g. a card was fixed) → it works again.
          // 2.4: paused (pause_collection) → PAUSED until it resumes; cancelling at the period end is remembered.
          const s = o.status, paused = !!o.pause_collection;
          const status = ['canceled', 'unpaid', 'incomplete_expired'].includes(s) ? 'CANCELLED' : paused && s === 'active' ? 'PAUSED' : ['active', 'trialing'].includes(s) ? 'ACTIVE' : null;
          const iso = t => t ? new Date(t * 1000).toISOString() : null;
          const n = await rpc('a3_subscription_sync', { p_subscription: o.id, p: { ...(status ? { status } : {}), current_period_end: iso(o.current_period_end),
            paused_until: paused ? iso(o.pause_collection.resumes_at) : null, cancel_at: o.cancel_at_period_end ? iso(o.cancel_at || o.current_period_end) : null } })
            .catch(async () => status && rpc('a3_set_status', { p_order: null, p_subscription: o.id, p_status: status }));   // before aargon3-2.4.sql
          return json({ received: true, updated: n ?? 0 });
        }
        case 'checkout.session.expired': {
          // only people who ticked "email me if I don't finish" on the store, never staff sales or custom-order links
          const m = o.metadata || {};
          const email = o.customer_details?.email || o.customer_email || m.a3_c_email;
          if (!m.a3_plan || m.a3_followup !== '1' || m.a3_source !== 'web' || !email) return json({ received: true, ignored: 'no reminder wanted' });
          const s = await rpc('a3_settings').catch(() => ({}));
          if (s?.followup?.enabled === false) return json({ received: true, ignored: 'reminders are off' });
          const sel = A3.selection({ plan: m.a3_plan, tier: m.a3_tier, billing: m.a3_billing, os: m.a3_os, connection: m.a3_connection });
          const mail = mailer(env, fetchImpl, s), link = `${mail.site}/${planLink(sel)}`;
          const label = m.a3_gift ? `a gift of ${A3.C.plans[sel.plan].name} ${A3.C.tiers[sel.tier].name}` : A3.label(sel);
          const saved = await rpc('a3_abandoned_save', { p: { session_id: o.id, order_id: m.a3_order, email, name: m.a3_c_first || '', label, amount_cents: o.amount_total ?? null, link } });
          if (!saved?.saved) return json({ received: true, ignored: saved?.reason || 'seen' });
          let err = null;
          try {
            await mail.message({ to_email: email, to_name: m.a3_c_first || '', subject: `You left ${label} in your cart`,
              heading: `Still want ${label}?`, message: `Hi${m.a3_c_first ? ` ${m.a3_c_first}` : ''}, you started checking out at ${mail.storeName} but didn't finish. Your plan is saved: pick up where you left off with the button below.\n\nYou're getting this one email because you asked us to remind you. We won't send another.`,
              button_label: 'Finish my order', button_url: link });
          } catch (e) { err = String(e.message || e).slice(0, 300); }
          await rpc('a3_abandoned_mark', { p_session: o.id, p_error: err });
          return json({ received: true, reminded: !err, error: err || undefined });
        }
        default: return json({ received: true, ignored: event.type });
      }
    } catch (e) {
      console.error('[stripe-webhook]', event?.type, e);
      return json({ error: e.message }, 500);   // Stripe retries on 5xx
    }
  };
}
