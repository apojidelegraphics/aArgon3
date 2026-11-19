-- ⚠ Wipes the sales data. There is no undo. Run it only when you're ready to launch (after testing Stripe in the sandbox).
--
-- PART 1: in the aARgon3 & Mexel Backend project (yuergfrpfhtcxjkcgjrx). Removes every order, shift, promotion and
-- staff log entry. Keeps stores, terms and all the new functions.
truncate table public.orders, public.shifts, public.promotions, public.staff_log restart identity;

-- PART 2: in the Nexus Backend project (yzbnxpkuhlxsuwzbjifx), NOT this one. Everyone who redeemed an old order loses
-- what it unlocked in Nexus '28 (the orders above no longer exist, so they couldn't be looked up anyway).
-- Copy the line below into that project's SQL Editor:
--
--   delete from public.redemptions;
