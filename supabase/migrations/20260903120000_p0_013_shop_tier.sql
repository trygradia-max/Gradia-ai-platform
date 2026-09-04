-- P0-013 — tier identity for the three-tier commercial model (D-031 / D-034).
--
-- `tier` is WHICH plan the shop bought (core | pro | operator); `plan` keeps
-- meaning subscription STATUS (free | active | past_due) — the two are
-- orthogonal on purpose. `trial_ends_at` mirrors Stripe's subscription
-- trial_end so the allowance code can apply the D-035 trial numbers while a
-- trial is running (interim: Stripe trial_period_days=14, card required).
--
-- Backfill: every existing row lands on `core` — the founder's decision for
-- pilot shops (autorun queue item 4: "existing pilot shops: grandfather as
-- core"). Grandfathered shops keep `plan='active'` with no Stripe
-- subscription and keep working under Core's allowances.
--
-- Additive + idempotent. Rollback: supabase/rollbacks/p0-013_shop_tier_drop.sql

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'core'
    CHECK (tier IN ('core', 'pro', 'operator')),
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;

-- Explicit backfill (a no-op after the DEFAULT, kept so the intent is in
-- the migration itself and a re-run is harmless).
UPDATE public.shops SET tier = 'core' WHERE tier IS NULL;

COMMENT ON COLUMN public.shops.tier IS
  'P0-013 (D-034): which Gradia plan the shop is on — core | pro | operator. Written only from Stripe truth by the webhook; existing shops backfilled to core.';
COMMENT ON COLUMN public.shops.trial_ends_at IS
  'P0-013 (D-035 interim): Stripe subscription trial_end mirrored so allowances apply the trial numbers while a trial runs. NULL = not trialing.';
