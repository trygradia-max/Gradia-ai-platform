BEGIN;
-- Owner attestation that a bring-your-own (non-Gradia) number is registered for
-- A2P 10DLC. It is the only writer of shops.byo_sms_verified, which gates every
-- text from such a number (smsGateForShop, stage_qualification_question). Gradia
-- numbers keep their own A2P gate and are never attested here. Nothing is sent and
-- no provider is called. See docs/architecture/BYO_SMS_ATTESTATION.md.

-- Append-only history: who attested, revoked, or what cleared it, and when.
CREATE TABLE public.byo_sms_attestations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 event text NOT NULL,
 source text NOT NULL,
 phone_e164 text,
 actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 statement_version text,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT byo_sms_attestations_event_source CHECK ((event,source) IN
  (('attested','owner_attestation'),('revoked','owner_revocation'),('cleared','number_changed'))),
 CONSTRAINT byo_sms_attestations_attested_fields CHECK (event<>'attested' OR (statement_version IS NOT NULL AND phone_e164 IS NOT NULL))
);
CREATE INDEX byo_sms_attestations_shop_created ON public.byo_sms_attestations(shop_id,created_at DESC,id);
ALTER TABLE public.byo_sms_attestations ENABLE ROW LEVEL SECURITY;
CREATE POLICY byo_sms_attestations_owner_read ON public.byo_sms_attestations FOR SELECT USING (public.team_is_owner(shop_id));
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.byo_sms_attestations FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.byo_sms_attestations_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Attestation history is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER byo_sms_attestations_no_update BEFORE UPDATE ON public.byo_sms_attestations
 FOR EACH ROW EXECUTE FUNCTION public.byo_sms_attestations_append_only();

-- A signed-in session (the shops owner RLS path) can no longer set the flag
-- directly; only the functions below can. Runs as the invoker on purpose: inside
-- those SECURITY DEFINER functions current_user is the definer, not authenticated.
-- Trusted server code (service_role) is not blocked here.
CREATE FUNCTION public.shops_byo_sms_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF current_user IN ('authenticated','anon') AND (
  (TG_OP='INSERT' AND NEW.byo_sms_verified) OR
  (TG_OP='UPDATE' AND NEW.byo_sms_verified IS DISTINCT FROM OLD.byo_sms_verified)) THEN
  RAISE EXCEPTION 'Use the owner attestation' USING ERRCODE='42501',DETAIL='attestation_required';
 END IF;
 RETURN NEW;
END $$;
-- BEFORE triggers fire by name: the guard (a_) sees the caller's own change before
-- the number-change clear (b_) adjusts the row.
CREATE TRIGGER shops_byo_sms_a_guard BEFORE INSERT OR UPDATE OF byo_sms_verified ON public.shops
 FOR EACH ROW EXECUTE FUNCTION public.shops_byo_sms_guard();

-- An attestation covers one number. Any change of the sending number, by any
-- writer, clears it and records why.
CREATE FUNCTION public.shops_byo_sms_number_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF OLD.byo_sms_verified AND NEW.byo_sms_verified AND NEW.twilio_phone_number IS DISTINCT FROM OLD.twilio_phone_number THEN
  NEW.byo_sms_verified:=false;
  INSERT INTO public.byo_sms_attestations(shop_id,event,source,phone_e164) VALUES (NEW.id,'cleared','number_changed',OLD.twilio_phone_number);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shops_byo_sms_b_number_change BEFORE UPDATE OF twilio_phone_number ON public.shops
 FOR EACH ROW EXECUTE FUNCTION public.shops_byo_sms_number_changed();

-- Private. The account owner only: shops.owner_id with an active owner membership.
-- Managers and staff never qualify, whatever their capabilities.
CREATE FUNCTION public.byo_sms_is_owner(p_shop uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT auth.uid() IS NOT NULL AND public.team_is_owner(p_shop) AND EXISTS(
  SELECT 1 FROM public.shop_memberships m WHERE m.shop_id=p_shop AND m.user_id=auth.uid() AND m.role='owner' AND m.active);
$$;

-- Private. The one presentation of the attestation, returned by every call. The
-- number predicate matches smsGateForShop and stage_qualification_question.
CREATE FUNCTION public.byo_sms_attestation_state(p_shop uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.shops; e public.byo_sms_attestations; v_number text;
BEGIN
 SELECT * INTO s FROM public.shops WHERE id=p_shop;
 v_number:=nullif(btrim(coalesce(s.twilio_phone_number,'')),'');
 SELECT * INTO e FROM public.byo_sms_attestations WHERE shop_id=p_shop ORDER BY created_at DESC,id DESC LIMIT 1;
 RETURN jsonb_build_object(
  'state',CASE WHEN v_number IS NULL THEN 'no_number'
   WHEN s.gradia_number_e164 IS NOT NULL AND s.twilio_phone_number=s.gradia_number_e164 THEN 'gradia_number'
   WHEN s.byo_sms_verified THEN 'confirmed' ELSE 'unconfirmed' END,
  'phone_e164',v_number,
  'current_statement_version','2026-10-15',
  'last_event',CASE WHEN e.id IS NULL THEN NULL ELSE jsonb_build_object('event',e.event,'source',e.source,'phone_e164',e.phone_e164,
   'actor_user_id',e.actor_user_id,'statement_version',e.statement_version,'created_at',e.created_at) END);
END $$;

CREATE FUNCTION public.read_byo_sms_attestation(p_shop uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT public.byo_sms_is_owner(p_shop) THEN RAISE EXCEPTION 'Attestation unavailable' USING ERRCODE='42501',DETAIL='forbidden'; END IF;
 RETURN public.byo_sms_attestation_state(p_shop);
END $$;

-- The owner confirms the number they were shown is registered. Idempotent by state:
-- confirming an already confirmed number writes nothing.
CREATE FUNCTION public.attest_byo_sms_registration(p_shop uuid,p_phone text,p_statement_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.shops;
BEGIN
 IF NOT public.byo_sms_is_owner(p_shop) THEN RAISE EXCEPTION 'Attestation unavailable' USING ERRCODE='42501',DETAIL='forbidden'; END IF;
 IF p_statement_version IS DISTINCT FROM '2026-10-15' THEN RAISE EXCEPTION 'Invalid attestation' USING ERRCODE='22023',DETAIL='statement_version'; END IF;
 SELECT * INTO s FROM public.shops WHERE id=p_shop FOR UPDATE;
 IF nullif(btrim(coalesce(s.twilio_phone_number,'')),'') IS NULL THEN
  RAISE EXCEPTION 'No number' USING ERRCODE='PT409',DETAIL='no_number'; END IF;
 IF s.gradia_number_e164 IS NOT NULL AND s.twilio_phone_number=s.gradia_number_e164 THEN
  RAISE EXCEPTION 'Gradia number' USING ERRCODE='PT409',DETAIL='gradia_number'; END IF;
 IF p_phone IS DISTINCT FROM s.twilio_phone_number THEN
  RAISE EXCEPTION 'Number changed' USING ERRCODE='PT409',DETAIL='number_changed'; END IF;
 IF s.byo_sms_verified THEN RETURN public.byo_sms_attestation_state(p_shop)||jsonb_build_object('status','already_attested'); END IF;
 UPDATE public.shops SET byo_sms_verified=true WHERE id=p_shop;
 INSERT INTO public.byo_sms_attestations(shop_id,event,source,phone_e164,actor_user_id,statement_version)
  VALUES (p_shop,'attested','owner_attestation',s.twilio_phone_number,auth.uid(),p_statement_version);
 RETURN public.byo_sms_attestation_state(p_shop)||jsonb_build_object('status','attested');
END $$;

-- The owner withdraws it; texts from the number are held again at send.
CREATE FUNCTION public.revoke_byo_sms_registration(p_shop uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.shops;
BEGIN
 IF NOT public.byo_sms_is_owner(p_shop) THEN RAISE EXCEPTION 'Attestation unavailable' USING ERRCODE='42501',DETAIL='forbidden'; END IF;
 SELECT * INTO s FROM public.shops WHERE id=p_shop FOR UPDATE;
 IF NOT s.byo_sms_verified THEN RETURN public.byo_sms_attestation_state(p_shop)||jsonb_build_object('status','already_revoked'); END IF;
 UPDATE public.shops SET byo_sms_verified=false WHERE id=p_shop;
 INSERT INTO public.byo_sms_attestations(shop_id,event,source,phone_e164,actor_user_id)
  VALUES (p_shop,'revoked','owner_revocation',nullif(btrim(coalesce(s.twilio_phone_number,'')),''),auth.uid());
 RETURN public.byo_sms_attestation_state(p_shop)||jsonb_build_object('status','revoked');
END $$;

REVOKE ALL ON FUNCTION public.byo_sms_attestations_append_only(),public.shops_byo_sms_guard(),public.shops_byo_sms_number_changed(),
 public.byo_sms_is_owner(uuid),public.byo_sms_attestation_state(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.read_byo_sms_attestation(uuid),public.attest_byo_sms_registration(uuid,text,text),
 public.revoke_byo_sms_registration(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.read_byo_sms_attestation(uuid),public.attest_byo_sms_registration(uuid,text,text),
 public.revoke_byo_sms_registration(uuid) TO authenticated;
COMMIT;
