-- ⚠ Wipes the sales data. There is no undo. Run it only when you're ready to launch (right after switching Stripe to
-- live mode: sandbox subscriptions, invoices and promo codes don't exist in live mode anyway).
--
-- PART 1: in the aARgon3 & Mexel Backend project (yuergfrpfhtcxjkcgjrx). Removes every order, payment, shift,
-- custom order / quote, promo code and staff log entry.
-- Keeps: the staff list (roles, pay rates), the schedule, time off, stores, settings, terms and all the functions.
truncate table public.orders, public.payments, public.shifts, public.quotes, public.promotions, public.staff_log restart identity;
-- After this, make your promo codes again in the terminal (Promotions) so they're created in live Stripe.

-- PART 2: in the Nexus Backend project (yzbnxpkuhlxsuwzbjifx), NOT this one. Everyone who redeemed an old order loses
-- what it unlocked in Nexus '28 (the orders above no longer exist, so they couldn't be looked up anyway).
-- Copy the line below into that project's SQL Editor:
--
--   delete from public.redemptions;
