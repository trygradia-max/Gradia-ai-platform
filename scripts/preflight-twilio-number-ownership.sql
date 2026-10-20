-- Read-only preflight for migration 20261019130000 and the I1 / R8 code changes.
-- Run against the target database BEFORE deploying. It writes nothing.
--
-- The guard trigger rejects no existing row (it only fires on a change made by a
-- signed-in session). What changes is behaviour for rows already stored:
--
-- 1. "fails_closed": a shop whose texting number is neither its Gradia number
--    nor backed by its own Twilio credentials. Until now it verified inbound and
--    sent through Gradia's master (env) account. After deploy it does so only if
--    TWILIO_PILOT_SHOP_NUMBERS lists `<shop id>=<that number>`; otherwise inbound
--    is refused (401) and sends are refused. DECISION per row: allowlist it (a
--    deliberate pilot), or clear the number.
-- 2. "not_e164": a stored number the owner action would no longer accept.
--    Nothing breaks, but inbound matching on it is unlikely to work.
-- 3. "gradia_number_not_active": a Gradia number is stored but the texting
--    number differs, so the shop isn't using the subaccount. Informational.
-- 4. "gradia_number_unstored_active": twilio_phone_number is set while
--    gradia_number_e164 is null and a subaccount exists — possibly a purchase
--    whose save half-failed (R8). Reconcile against the subaccount's numbers.
SELECT s.id AS shop_id, s.twilio_phone_number, s.gradia_number_e164,
 (nullif(btrim(coalesce(s.twilio_account_sid_enc,'')),'') IS NOT NULL
  AND nullif(btrim(coalesce(s.twilio_auth_token_enc,'')),'') IS NOT NULL) AS has_own_credentials,
 s.twilio_subaccount_sid IS NOT NULL AS has_subaccount,
 CASE
  WHEN s.twilio_phone_number !~ '^\+[0-9]{8,15}$' THEN 'not_e164'
  WHEN s.gradia_number_e164 IS NOT NULL AND s.twilio_phone_number = s.gradia_number_e164 THEN NULL
  WHEN nullif(btrim(coalesce(s.twilio_account_sid_enc,'')),'') IS NULL
    OR nullif(btrim(coalesce(s.twilio_auth_token_enc,'')),'') IS NULL THEN 'fails_closed'
 END AS finding
FROM public.shops s
WHERE s.twilio_phone_number IS NOT NULL
 AND (s.twilio_phone_number !~ '^\+[0-9]{8,15}$'
  OR ((s.gradia_number_e164 IS NULL OR s.twilio_phone_number <> s.gradia_number_e164)
   AND (nullif(btrim(coalesce(s.twilio_account_sid_enc,'')),'') IS NULL
    OR nullif(btrim(coalesce(s.twilio_auth_token_enc,'')),'') IS NULL)))
UNION ALL
SELECT s.id, s.twilio_phone_number, s.gradia_number_e164, NULL, s.twilio_subaccount_sid IS NOT NULL,
 'gradia_number_not_active'
FROM public.shops s
WHERE s.gradia_number_e164 IS NOT NULL AND s.twilio_phone_number IS DISTINCT FROM s.gradia_number_e164
UNION ALL
SELECT s.id, s.twilio_phone_number, s.gradia_number_e164, NULL, true, 'gradia_number_unstored_active'
FROM public.shops s
WHERE s.twilio_subaccount_sid IS NOT NULL AND s.gradia_number_e164 IS NULL AND s.twilio_phone_number IS NOT NULL
ORDER BY 6, 1;

-- Delivery status (I5): no data change. Informational count of messages whose
-- stored status is earlier than a status Twilio may already have reported; the
-- fix only stops future regressions and does not backfill.
SELECT metadata->>'twilio_status' AS twilio_status, count(*)
FROM public.interactions
WHERE channel = 'sms' AND metadata ? 'twilio_message_sid'
GROUP BY 1 ORDER BY 2 DESC;
