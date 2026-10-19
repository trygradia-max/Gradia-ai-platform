-- Read-only preflight for the October 15 migrations integrated on claude/integration-oct17:
--   20261015120000_qualification_question_currency   (#83)
--   20261015130000_twilio_subaccount_unique          (#87)
--   20261015140000_a2p_registration_resume           (#88)
--   20261015150000_byo_sms_attestation               (#93)
-- Run BEFORE applying them, as a role that can read public.shops (e.g. postgres in
-- the SQL editor). It runs in a READ ONLY transaction and rolls back; it changes
-- nothing and prints no secrets (subaccount SIDs are shown only by their last 4).
-- Every row is one finding. severity:
--   block   the migration will fail (and change nothing) until this is resolved
--   decide  the migration succeeds, but the release lane must decide first
--   info    expected state, recorded for the release notes
-- See docs/release/TWILIO_REVIEW_AND_PROVIDER_CHECKLIST.md (Migrations).
BEGIN READ ONLY;

WITH ledger AS (
  SELECT version FROM supabase_migrations.schema_migrations
), dup_sub AS (
  SELECT twilio_subaccount_sid AS sid, array_agg(id ORDER BY created_at) AS shops, count(*) AS n
  FROM public.shops WHERE twilio_subaccount_sid IS NOT NULL
  GROUP BY twilio_subaccount_sid HAVING count(*) > 1
), byo AS (
  SELECT id,
    gradia_number_e164 IS NOT NULL AND twilio_phone_number = gradia_number_e164 AS on_gradia_number,
    nullif(btrim(coalesce(twilio_phone_number,'')),'') IS NULL AS no_number,
    nullif(btrim(coalesce(twilio_account_sid_enc,'')),'') IS NOT NULL
      AND nullif(btrim(coalesce(twilio_auth_token_enc,'')),'') IS NOT NULL AS own_account
  FROM public.shops WHERE byo_sms_verified
)
SELECT * FROM (
  -- Ledger position: main's last must be applied. A migration already in the ledger
  -- (a resumed upgrade after a refusal) is skipped by `migration up`, so its
  -- objects existing is expected; an object existing WITHOUT its ledger row blocks.
  SELECT 'ledger: main baseline 20261014120000 applied' AS check_name,
    CASE WHEN EXISTS (SELECT 1 FROM ledger WHERE version='20261014120000') THEN 'info' ELSE 'block' END AS severity,
    NULL::bigint AS count, 'Apply main''s migrations first.' AS detail
  UNION ALL
  SELECT 'ledger: already applied ' || v, 'info', NULL, 'Resumed upgrade: migration up skips it. Its checks below are skipped.'
  FROM unnest(ARRAY['20261015120000','20261015130000','20261015140000','20261015150000']) v
  WHERE v IN (SELECT version FROM ledger)

  -- #83: CREATE FUNCTION (no OR REPLACE).
  UNION ALL
  SELECT '#83: qualification_question_currency already exists', 'block', NULL, 'The migration uses CREATE FUNCTION and would fail.'
  WHERE EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='qualification_question_currency')
    AND NOT EXISTS (SELECT 1 FROM ledger WHERE version='20261015120000')
  UNION ALL
  SELECT '#83: queued qualification questions not yet decided', 'info',
    (SELECT count(*) FROM public.pending_actions WHERE action_type::text IN ('send_sms','send_email') AND payload ? 'qualification' AND status IN ('pending','edit_requested')),
    'After deploy these are re-checked at send and held if their record moved on.'

  -- #87: unique index on shops.twilio_subaccount_sid.
  UNION ALL
  SELECT '#87: subaccount SID shared by ' || n || ' shops (…' || right(sid,4) || ')', 'block', n,
    'Shops ' || array_to_string(shops, ', ') || '. Reconcile so each SID belongs to one shop (see the runbook). Never drop the index to proceed.'
  FROM dup_sub
  UNION ALL
  SELECT '#87: index shops_twilio_subaccount_sid_unique already exists', 'block', NULL, 'The migration uses CREATE UNIQUE INDEX and would fail.'
  WHERE EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='shops_twilio_subaccount_sid_unique')
    AND NOT EXISTS (SELECT 1 FROM ledger WHERE version='20261015130000')
  UNION ALL
  SELECT '#87: shops with a stored subaccount SID', 'info', (SELECT count(*) FROM public.shops WHERE twilio_subaccount_sid IS NOT NULL), NULL

  -- #88: ADD COLUMN (no IF NOT EXISTS); additive, no data rewritten.
  UNION ALL
  SELECT '#88: a2p_registrations.' || c || ' already exists', 'block', NULL, 'The migration uses ADD COLUMN and would fail.'
  FROM unnest(ARRAY['failed_step','retryable','attempts','last_attempt_at']) c
  WHERE EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='a2p_registrations' AND column_name=c)
    AND NOT EXISTS (SELECT 1 FROM ledger WHERE version='20261015140000')
  UNION ALL
  SELECT '#88: registrations by status: ' || status, 'info', count(*),
    CASE status WHEN 'draft' THEN 'No failed_step after migration: the wizard offers Submit.'
      WHEN 'rejected' THEN 'No failed_step after migration: the wizard offers Fix and resubmit (brand path), not campaign-only.'
      ELSE NULL END
  FROM public.a2p_registrations GROUP BY status

  -- #93: new table, functions and triggers; existing flags have no attestation record.
  UNION ALL
  SELECT '#93: byo_sms_attestations already exists', 'block', NULL, 'The migration uses CREATE TABLE and would fail.'
  WHERE to_regclass('public.byo_sms_attestations') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM ledger WHERE version='20261015150000')
  UNION ALL
  SELECT '#93: byo_sms_verified=true WITHOUT the shop''s own Twilio credentials', 'decide', count(*),
    'Texts from these non-Gradia numbers stay open after migration and would send through Gradia''s account. Recommend clearing before deploy.'
  FROM byo WHERE NOT on_gradia_number AND NOT no_number AND NOT own_account HAVING count(*) > 0
  UNION ALL
  SELECT '#93: byo_sms_verified=true on own account, no attestation record', 'decide', count(*),
    'Stays open with no who/when. Either keep (record the decision) or clear so the owner confirms in-app.'
  FROM byo WHERE NOT on_gradia_number AND NOT no_number AND own_account HAVING count(*) > 0
  UNION ALL
  SELECT '#93: byo_sms_verified=true with no number or on the Gradia number', 'info', count(*),
    'Has no effect at send (the A2P gate applies to the Gradia number).'
  FROM byo WHERE on_gradia_number OR no_number HAVING count(*) > 0
) findings
ORDER BY CASE severity WHEN 'block' THEN 0 WHEN 'decide' THEN 1 ELSE 2 END, check_name;

ROLLBACK;
