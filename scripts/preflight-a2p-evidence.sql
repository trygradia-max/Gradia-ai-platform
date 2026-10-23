-- Read-only preflight for 20261020100000_a2p_campaign_evidence.sql.
-- Run it against the target database BEFORE applying the migration. It writes
-- nothing. The migration gives every approved shop NULL evidence, so each shop
-- counted in the second column has its Gradia-number texts held until its
-- first successful status check (or until the release lane chooses a grace
-- backfill instead).
SELECT
  count(*) FILTER (WHERE a2p_status = 'approved') AS approved_shops,
  count(*) FILTER (WHERE a2p_status = 'approved'
    AND gradia_number_e164 IS NOT NULL
    AND twilio_phone_number = gradia_number_e164) AS gradia_number_texts_held_after_migration
FROM public.shops;
