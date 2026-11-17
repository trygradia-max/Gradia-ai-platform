BEGIN;
-- Security audit run-1, residual of finding #6: the voice provider identity and the voice
-- launch gate are still owner-writable.
--
-- shops_update_own / shops_insert_own (20260507220000_gradia_core.sql) let a signed-in owner
-- write ANY column of their own row through PostgREST. 20261110130000 closed the billing,
-- Stripe, number and minute-budget columns but deliberately left these five, so an owner
-- holding only their own JWT could:
--   vapi_assistant_id      point the shop at any Vapi assistant id. The inbound webhook
--                          routes a call to the shop whose vapi_assistant_id matches, and the
--                          hourly voice sync PATCHes (rewrites prompt, server URL and secret
--                          of) whatever assistant is stored here, so a foreign or unclaimed
--                          assistant could be hijacked or inbound calls attributed to the
--                          wrong shop. (The partial unique index only stops two shops holding
--                          the same id; it proves nothing about who owns it at the provider.)
--   vapi_phone_number_id   store a provider number id Gradia never imported for this shop; the
--                          launch-gate test call then dials out from that number id.
--   voice_test_called_at   claim a test call that never happened.
--   voice_live             go live without the number, assistant and test call the launch
--                          gate requires (the gate ran only in the server action, before an
--                          owner-session UPDATE, so a direct PATCH skipped it entirely).
--   vapi_server_secret_enc choose the per-shop webhook secret that authenticates Vapi calls,
--                          letting the owner mint call events (and metered minutes) for the
--                          shop with a secret they know.
--
-- From here on those columns are server-written. This extends the existing guard function in
-- place (CREATE OR REPLACE; the trigger shops_a_protected_columns_guard is unchanged and keeps
-- its name, timing and SECURITY INVOKER semantics): authenticated/anon are refused with
-- 42501, DETAIL 'server_written', HINT = the column; service_role, SECURITY DEFINER functions
-- and migrations are not (current_user is not authenticated/anon). Every protected column from
-- the previous migration is carried over verbatim.
--
--   UPDATE  Any change to a protected column by authenticated/anon is refused, including
--           clearing to NULL and including voice_live in BOTH directions: pausing the
--           receptionist is an owner action too, but it now goes through the session-derived,
--           owner-reverified server action (setVoiceLive) which writes with the service
--           client, so the owner-facing behaviour is unchanged. vapi_stale keeps its
--           true -> false-only rule.
--   INSERT  authenticated/anon must leave each of the five at its column default (NULL, NULL,
--           NULL, false, NULL), so a new shop cannot be born live or holding a provider id.
--
-- Not protected, deliberately: voice_config (the owner's own form answers: greeting, tone,
-- hours text, booking mode, escalation number; the system prompt is composed server-side from
-- it) and credit_limit. Existing rows are not changed or re-validated; the migration replaces
-- one function body and nothing else. A shop already carrying forged values from before this
-- migration is NOT cleaned up here (no data is touched); see the PR for the read-only query.
--
-- The guard cannot prove that a provider id stored by trusted server code belongs to the shop
-- at Vapi: that rests on the writers (syncVoiceAssistant / attachVoiceNumber only ever store
-- ids Vapi returned for a call the server just made with this shop's own data).
CREATE OR REPLACE FUNCTION public.shops_protected_columns_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE
 v_col text;
BEGIN
 IF current_user NOT IN ('authenticated','anon') THEN
  RETURN NEW;
 END IF;

 IF TG_OP='INSERT' THEN
  -- credit_period_start defaults to now(), which is the transaction timestamp the default
  -- was just evaluated with; any other value was supplied by the caller.
  v_col := CASE
   WHEN NEW.plan IS DISTINCT FROM 'free' THEN 'plan'
   WHEN NEW.voice_addon IS DISTINCT FROM false THEN 'voice_addon'
   WHEN NEW.voice_addon_ended_at IS NOT NULL THEN 'voice_addon_ended_at'
   WHEN NEW.stripe_subscription_id IS NOT NULL THEN 'stripe_subscription_id'
   WHEN NEW.credit_period_start IS DISTINCT FROM now() THEN 'credit_period_start'
   WHEN NEW.stripe_account_id IS NOT NULL THEN 'stripe_account_id'
   WHEN NEW.stripe_charges_enabled IS DISTINCT FROM false THEN 'stripe_charges_enabled'
   WHEN NEW.vapi_stale IS DISTINCT FROM false THEN 'vapi_stale'
   WHEN NEW.voice_minutes_budget IS NOT NULL THEN 'voice_minutes_budget'
   WHEN NEW.gradia_number_e164 IS NOT NULL THEN 'gradia_number_e164'
   WHEN NEW.gradia_number_sid IS NOT NULL THEN 'gradia_number_sid'
   WHEN NEW.twilio_subaccount_sid IS NOT NULL THEN 'twilio_subaccount_sid'
   WHEN NEW.twilio_subaccount_token_enc IS NOT NULL THEN 'twilio_subaccount_token_enc'
   WHEN NEW.number_purchase_claim IS NOT NULL THEN 'number_purchase_claim'
   WHEN NEW.number_purchase_claimed_at IS NOT NULL THEN 'number_purchase_claimed_at'
   WHEN NEW.vapi_assistant_id IS NOT NULL THEN 'vapi_assistant_id'
   WHEN NEW.vapi_phone_number_id IS NOT NULL THEN 'vapi_phone_number_id'
   WHEN NEW.voice_live IS DISTINCT FROM false THEN 'voice_live'
   WHEN NEW.voice_test_called_at IS NOT NULL THEN 'voice_test_called_at'
   WHEN NEW.vapi_server_secret_enc IS NOT NULL THEN 'vapi_server_secret_enc'
  END;
 ELSE
  v_col := CASE
   WHEN NEW.plan IS DISTINCT FROM OLD.plan THEN 'plan'
   WHEN NEW.voice_addon IS DISTINCT FROM OLD.voice_addon THEN 'voice_addon'
   WHEN NEW.voice_addon_ended_at IS DISTINCT FROM OLD.voice_addon_ended_at THEN 'voice_addon_ended_at'
   WHEN NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id THEN 'stripe_subscription_id'
   WHEN NEW.credit_period_start IS DISTINCT FROM OLD.credit_period_start THEN 'credit_period_start'
   WHEN NEW.stripe_account_id IS DISTINCT FROM OLD.stripe_account_id THEN 'stripe_account_id'
   WHEN NEW.stripe_charges_enabled IS DISTINCT FROM OLD.stripe_charges_enabled THEN 'stripe_charges_enabled'
   WHEN OLD.vapi_stale AND NOT NEW.vapi_stale THEN 'vapi_stale'
   WHEN NEW.voice_minutes_budget IS DISTINCT FROM OLD.voice_minutes_budget THEN 'voice_minutes_budget'
   WHEN NEW.gradia_number_e164 IS DISTINCT FROM OLD.gradia_number_e164 THEN 'gradia_number_e164'
   WHEN NEW.gradia_number_sid IS DISTINCT FROM OLD.gradia_number_sid THEN 'gradia_number_sid'
   WHEN NEW.twilio_subaccount_sid IS DISTINCT FROM OLD.twilio_subaccount_sid THEN 'twilio_subaccount_sid'
   WHEN NEW.twilio_subaccount_token_enc IS DISTINCT FROM OLD.twilio_subaccount_token_enc THEN 'twilio_subaccount_token_enc'
   WHEN NEW.number_purchase_claim IS DISTINCT FROM OLD.number_purchase_claim THEN 'number_purchase_claim'
   WHEN NEW.number_purchase_claimed_at IS DISTINCT FROM OLD.number_purchase_claimed_at THEN 'number_purchase_claimed_at'
   WHEN NEW.vapi_assistant_id IS DISTINCT FROM OLD.vapi_assistant_id THEN 'vapi_assistant_id'
   WHEN NEW.vapi_phone_number_id IS DISTINCT FROM OLD.vapi_phone_number_id THEN 'vapi_phone_number_id'
   WHEN NEW.voice_live IS DISTINCT FROM OLD.voice_live THEN 'voice_live'
   WHEN NEW.voice_test_called_at IS DISTINCT FROM OLD.voice_test_called_at THEN 'voice_test_called_at'
   WHEN NEW.vapi_server_secret_enc IS DISTINCT FROM OLD.vapi_server_secret_enc THEN 'vapi_server_secret_enc'
  END;
 END IF;

 IF v_col IS NOT NULL THEN
  RAISE EXCEPTION 'This shop field is set by Gradia' USING ERRCODE='42501', DETAIL='server_written', HINT=v_col;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shops_protected_columns_guard() FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
