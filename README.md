# aARgon3

The Apoji systems store for Nexus '28, and the staff terminal that sells it.

- **Store** (public, GitHub Pages): https://apojidelegraphics.github.io/aArgon3/ — plans, models, Stripe checkout, order number.
- **Terminal** (staff only): https://apojidelegraphics.github.io/aArgon3/terminal/ and the **aARgon3** desktop app for Mac and Windows
  ([Releases](https://github.com/apojidelegraphics/aArgon3/releases/latest)). Sign in with a Nexus admin account.

## What's where

| Path | What |
|---|---|
| `index.html`, `success.html`, `terms/` | The store, the thank-you page (shows the order number), Terms of Sale |
| `terminal/` | The staff terminal: clock in/out, breaks, new sale (QR code / payment link), orders, timesheets, activity |
| `electron/` | The desktop app (loads `terminal/` from inside the app) |
| `catalog.json` | **Prices, tiers, models, LentOS and connections.** Edit, then `npm run catalog` |
| `supabase/aargon3-2.0.sql` | Database: locks the tables down, Stripe columns, stores, the new clock, server functions |
| `supabase/functions/` | Edge Functions: `checkout` (store), `stripe-webhook` (Stripe), `staff` (terminal) |
| `supabase/wipe.sql` | Clears all sales data before launch (no undo) |

## Who can do what

The repo is public, so nothing secret lives here. The pages only hold public keys. Everything that matters is checked on the server:

- **Customers** can only start a Stripe Checkout. The price is worked out again on the server from `catalog.json`.
- **Orders** are only written after Stripe confirms payment (webhook, or the thank-you page asking Stripe directly).
- **Staff**: the `staff` function checks every request's Nexus sign-in against Nexus's `admin_roles`. Any admin level can clock in and sell.
  **high-admin** accounts are managers: everyone's timesheets, fixing shifts, free (comp) orders, cancel and refund, activity log.
- **Nexus '28** can still look up an order by number (5 columns: number, plan, status, system, models), never customer details.

## Setup

1. **Database**: Supabase → aARgon3 & Mexel Backend → SQL Editor → run `supabase/aargon3-2.0.sql`.
2. **Secrets**: Supabase → Edge Functions → Secrets: `STRIPE_SECRET_KEY` (`sk_test_…` while testing), `STRIPE_WEBHOOK_SECRET` (step 4),
   `SITE_URL` = `https://apojidelegraphics.github.io/aArgon3`.
3. **Functions**: deploy `checkout`, `stripe-webhook` and `staff` with **verify JWT off** (`supabase/config.toml` has this), e.g.
   `npx supabase functions deploy --project-ref yuergfrpfhtcxjkcgjrx`.
4. **Stripe webhook**: Stripe → Developers → Webhooks → Add endpoint
   `https://yuergfrpfhtcxjkcgjrx.supabase.co/functions/v1/stripe-webhook`, events `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy its signing secret into step 2.
5. **Pages**: GitHub → Settings → Pages → Deploy from a branch → `main` / root.
6. Optional: Stripe → Settings → Billing → Customer portal → copy the login link into `assets/config.js` (`portalUrl`).

Test with card `4242 4242 4242 4242`, any future date, any CVC.

## Develop

```
npm install
npm start          # the desktop app
npm run site       # the website at http://localhost:8028
npm test           # A3_PG="-h /tmp -p 5432 -U postgres" npm test also runs the SQL against a scratch Postgres
```

Releasing the desktop app: push a tag like `v2.0.0`. GitHub Actions builds the Mac DMGs and Windows installer and publishes a release.

© 2026 Apoji Delegraphics. All rights reserved.
