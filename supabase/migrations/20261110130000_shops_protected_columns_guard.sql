BEGIN;
-- Security audit run-1, findings #2, #5 and #8: one root cause.
--
-- shops_insert_own / shops_update_own (20260507220000_gradia_core.sql) let a signed-in
-- owner write ANY column of their own row through PostgREST, and the only guards so far
-- cover the texting number, BYO attestation and A2P columns. An owner could therefore:
--   #2  grant themselves the paid plan, the Voice add-on, a fresh credit period or a
--       Stripe subscription/Connect identity;
--   #5  clear the "stale" flag and the minute budget the voice sync keys on, so the
--       cancelled / exhausted receptionist is never switched to its fallback;
--   #8  write the Gradia number, or the Twilio subaccount identity, and launder a number
--       through saveTwilioNumber's "is this the shop's own Gradia number" check.
--
-- From here on those columns are server-written. Same pattern as
-- shops_twilio_phone_number_guard and #93's shops_byo_sms_guard: the function runs as the
-- INVOKER on purpose, so a signed-in session (authenticated) or anon is refused, while
-- service_role, SECURITY DEFINER functions and migrations (current_user is the definer or
-- postgres) are not. Trusted server code authorizes the owner in the action and then uses
-- the service client; Stripe, billing, voice, provisioning and onboarding writers already do.
--
--   UPDATE  Any change to a protected column by authenticated/anon is refused, including
--           clearing to NULL. The one exception is vapi_stale, which owner actions
--           legitimately raise through markVoiceStale (menu, knowledge, hours edits): only
--           true -> false is refused.
--   INSERT  authenticated/anon must leave every protected column at its column default,
--           so a new shop cannot be born paid, entitled or holding a number.
--
-- The trigger has no "UPDATE OF" column list, so no UPDATE form (multi-column assignment,
-- upsert, copy from another column) can skip it. Existing rows are not changed or
-- re-validated; the migration only adds a function and a trigger.
--
-- Deliberately NOT protected (owner-editable settings, unchanged): name, contact fields,
-- settings, credit_limit (the owner's own auto-top-up ceiling), voice_config, voice_live,
-- persona/working-hours/integration settings and every other column not listed below.
CREATE FUNCTION public.shops_protected_columns_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
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
  END;
 END IF;

 IF v_col IS NOT NULL THEN
  RAISE EXCEPTION 'This shop field is set by Gradia' USING ERRCODE='42501', DETAIL='server_written', HINT=v_col;
 END IF;
 RETURN NEW;
END $$;
-- Name sorts after shops_a2p_guard and before the shops_byo_sms_* triggers.
CREATE TRIGGER shops_a_protected_columns_guard BEFORE INSERT OR UPDATE ON public.shops
 FOR EACH ROW EXECUTE FUNCTION public.shops_protected_columns_guard();
REVOKE ALL ON FUNCTION public.shops_protected_columns_guard() FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
