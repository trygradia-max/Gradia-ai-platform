BEGIN;
-- Review finding I1 (docs/release/TWILIO_REVIEW_AND_PROVIDER_CHECKLIST.md).
-- shops.twilio_phone_number routes inbound texts to a shop (api/twilio/sms
-- matches on it) and picks the sending number. Until now the shops owner RLS
-- policy let a signed-in owner record ANY number there, with no proof the shop
-- holds it. From here on only trusted server code writes it:
--   - saveTwilioNumber, after checking the number is on the shop's own Twilio
--     account (or is its Gradia number, or its allowlisted pilot number);
--   - the purchase, provision, release and disconnect paths.
-- They use the service role after authorizing the owner in the action.
--
-- Same pattern as #93's shops_byo_sms_guard: runs as the invoker on purpose, so
-- a signed-in session (authenticated) or anon is refused, while service_role
-- and SECURITY DEFINER functions are not. Clearing to NULL is refused too: the
-- column is server-written in both directions.
--
-- Existing rows are not changed or re-validated. Run
-- scripts/preflight-twilio-number-ownership.sql first: it lists the stored
-- numbers whose inbound will now fail closed unless the shop is allowlisted.
CREATE FUNCTION public.shops_twilio_phone_number_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF current_user IN ('authenticated','anon') AND (
  (TG_OP='INSERT' AND NEW.twilio_phone_number IS NOT NULL) OR
  (TG_OP='UPDATE' AND NEW.twilio_phone_number IS DISTINCT FROM OLD.twilio_phone_number)) THEN
  RAISE EXCEPTION 'The texting number is set by Gradia' USING ERRCODE='42501',DETAIL='server_written';
 END IF;
 RETURN NEW;
END $$;
-- Name sorts before #93's shops_byo_sms_* triggers, so a refused change never
-- reaches the attestation clear.
CREATE TRIGGER shops_a_twilio_phone_number_guard BEFORE INSERT OR UPDATE OF twilio_phone_number ON public.shops
 FOR EACH ROW EXECUTE FUNCTION public.shops_twilio_phone_number_guard();
REVOKE ALL ON FUNCTION public.shops_twilio_phone_number_guard() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
