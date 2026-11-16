-- READ ONLY. Run by an operator against a database BEFORE or AFTER applying
-- 20261115120000_shops_voice_columns_guard. The migration deliberately changes no data; this lists
-- existing shops whose voice identity or launch gate could have been forged while those columns were
-- owner-writable. Nothing here writes. Review each row with its owner before touching it.
-- Prints no secret: vapi_server_secret_enc is reported only as present/absent.
BEGIN READ ONLY;

-- 1. Live without the launch gate (number, assistant and a completed test call), or live without the add-on.
SELECT 'live_without_gate' AS finding, id AS shop_id, name, voice_addon,
       vapi_assistant_id IS NOT NULL AS has_assistant, vapi_phone_number_id IS NOT NULL AS has_number,
       voice_test_called_at IS NOT NULL AS has_test_call
  FROM public.shops
 WHERE voice_live
   AND (NOT voice_addon OR vapi_assistant_id IS NULL OR vapi_phone_number_id IS NULL OR voice_test_called_at IS NULL);

-- 2. A test call is recorded but the shop has no assistant/number to have made it from.
SELECT 'test_call_without_identity' AS finding, id AS shop_id, name
  FROM public.shops
 WHERE voice_test_called_at IS NOT NULL AND (vapi_assistant_id IS NULL OR vapi_phone_number_id IS NULL);

-- 3. One provider number id stored on more than one shop (no unique index exists for it; the assistant id has one).
SELECT 'shared_vapi_phone_number_id' AS finding, vapi_phone_number_id, count(*) AS shops, array_agg(id ORDER BY created_at) AS shop_ids
  FROM public.shops
 WHERE vapi_phone_number_id IS NOT NULL
 GROUP BY vapi_phone_number_id HAVING count(*) > 1;

-- 4. A provider identity stored on a shop with no Gradia number to route it from.
SELECT 'identity_without_gradia_number' AS finding, id AS shop_id, name,
       vapi_assistant_id IS NOT NULL AS has_assistant, vapi_phone_number_id IS NOT NULL AS has_number
  FROM public.shops
 WHERE (vapi_assistant_id IS NOT NULL OR vapi_phone_number_id IS NOT NULL) AND gradia_number_e164 IS NULL;

-- 5. A webhook secret stored without an assistant (the server writes the secret only when it syncs one).
SELECT 'secret_without_assistant' AS finding, id AS shop_id, name
  FROM public.shops
 WHERE vapi_server_secret_enc IS NOT NULL AND vapi_assistant_id IS NULL;

ROLLBACK;
