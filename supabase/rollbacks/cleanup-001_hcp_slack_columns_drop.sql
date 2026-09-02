-- CLEANUP-001 (D-052) — OPTIONAL, NOT APPLIED. Not a migration.
--
-- The Housecall Pro connector was deleted 2026-09-01 (autorun Batch 1).
-- Its columns are HCP-only and now dormant. Dropping them is a founder
-- decision to run by hand AFTER confirming, on Production, that no row
-- carries data worth keeping (SELECT count(*) FROM shops WHERE
-- housecallpro_account_id IS NOT NULL; etc.). Reversible only by restore —
-- which is exactly why this file is not in supabase/migrations/.
--
-- KEPT ON PURPOSE (do not add here): pending_actions.decided_by_slack,
-- pending_actions.slack_channel, pending_actions.slack_message_ts —
-- historical approval decisions reference them.

BEGIN;

ALTER TABLE public.shops
  DROP COLUMN IF EXISTS housecallpro_account_id,
  DROP COLUMN IF EXISTS housecallpro_account_name,
  DROP COLUMN IF EXISTS housecallpro_access_token_enc,
  DROP COLUMN IF EXISTS housecallpro_refresh_token_enc,
  DROP COLUMN IF EXISTS housecallpro_token_expires_at;

DROP INDEX IF EXISTS public.customers_housecallpro_customer_id_idx;
ALTER TABLE public.customers DROP COLUMN IF EXISTS housecallpro_customer_id;
ALTER TABLE public.appointments DROP COLUMN IF EXISTS housecallpro_job_id;

COMMIT;
