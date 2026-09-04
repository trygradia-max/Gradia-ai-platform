-- P0-013 rollback — drops the tier identity columns. Non-destructive to
-- ledgers (usage_events / credit_grants untouched); every shop reads as the
-- pre-P0-013 two-SKU model again. Run by hand, never as a migration:
--   psql -f supabase/rollbacks/p0-013_shop_tier_drop.sql
ALTER TABLE public.shops DROP COLUMN IF EXISTS tier;
ALTER TABLE public.shops DROP COLUMN IF EXISTS trial_ends_at;
