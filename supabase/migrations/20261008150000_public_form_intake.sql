BEGIN;

-- The public form id is a routing key, never customer identity or consent.
CREATE TABLE public.public_intake_forms (
 id uuid PRIMARY KEY,
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 allowed_origin text NOT NULL CHECK (length(allowed_origin) BETWEEN 9 AND 253 AND allowed_origin ~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'),
 enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.public_intake_forms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.public_intake_forms FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX public_intake_forms_shop ON public.public_intake_forms(shop_id);
CREATE INDEX public_form_intake_received ON public.lead_intake_envelopes(shop_id,received_at)
 WHERE provider='public_website_form';

CREATE FUNCTION public.configure_public_intake_form(p_shop uuid,p_form uuid,p_origin text,p_enabled boolean,p_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE f public.public_intake_forms;
BEGIN
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 IF auth.uid() IS NULL OR NOT public.team_is_owner(p_shop) OR NOT EXISTS(
  SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND role='owner' AND active
 ) THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
 IF p_form IS NULL OR p_enabled IS NULL OR p_revision IS NULL OR p_revision<0 OR p_origin IS NULL
  OR length(p_origin)>253 OR p_origin !~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'
 THEN RAISE EXCEPTION 'Invalid form configuration' USING ERRCODE='22023'; END IF;
 SELECT * INTO f FROM public.public_intake_forms WHERE id=p_form FOR UPDATE;
 IF FOUND THEN
  IF f.shop_id<>p_shop THEN RAISE EXCEPTION 'Form unavailable' USING ERRCODE='42501'; END IF;
  IF f.revision<>p_revision THEN RAISE EXCEPTION 'Configuration changed' USING ERRCODE='PT409'; END IF;
  UPDATE public.public_intake_forms SET allowed_origin=p_origin,enabled=p_enabled,revision=revision+1,updated_by=auth.uid(),updated_at=clock_timestamp() WHERE id=p_form RETURNING * INTO f;
 ELSE
  IF p_revision<>0 THEN RAISE EXCEPTION 'Configuration changed' USING ERRCODE='PT409'; END IF;
  INSERT INTO public.public_intake_forms(id,shop_id,allowed_origin,enabled,created_by,updated_by)
   VALUES(p_form,p_shop,p_origin,p_enabled,auth.uid(),auth.uid()) RETURNING * INTO f;
 END IF;
 RETURN jsonb_build_object('id',f.id,'shop_id',f.shop_id,'allowed_origin',f.allowed_origin,'enabled',f.enabled,'revision',f.revision);
END $$;

CREATE FUNCTION public.list_public_intake_forms(p_shop uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT public.team_is_owner(p_shop) OR NOT EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND role='owner' AND active)
 THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(f)),'[]'::jsonb) FROM (
  SELECT id,shop_id,allowed_origin,enabled,revision FROM public.public_intake_forms WHERE shop_id=p_shop ORDER BY created_at,id
 ) f);
END $$;

CREATE FUNCTION public.public_intake_form_origin(p_form uuid,p_origin text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.public_intake_forms f JOIN public.shops s ON s.id=f.shop_id
 JOIN public.shop_memberships m ON m.shop_id=s.id AND m.user_id=s.owner_id AND m.role='owner' AND m.active
 WHERE f.id=p_form AND f.enabled AND f.allowed_origin=p_origin);
$$;

CREATE FUNCTION public.submit_public_intake_form(p_form uuid,p_origin text,p_submission uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE f public.public_intake_forms; tenant uuid; normalized jsonb; existing public.lead_intake_envelopes; event_key text; received timestamptz;
BEGIN
 -- Same lock order as owner configuration and membership changes. Form keys
 -- cannot be rebound to another shop. Revocation serializes with acceptance.
 SELECT shop_id INTO tenant FROM public.public_intake_forms WHERE id=p_form;
 IF tenant IS NULL THEN RAISE EXCEPTION 'Form unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.shops WHERE id=tenant FOR UPDATE;
 SELECT * INTO f FROM public.public_intake_forms WHERE id=p_form FOR UPDATE;
 IF NOT public.public_intake_form_origin(p_form,p_origin) THEN RAISE EXCEPTION 'Form unavailable' USING ERRCODE='42501'; END IF;
 IF p_submission IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>16384 THEN
  RAISE EXCEPTION 'Invalid submission' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('display_name','phone','email','message','vehicle_text','service_text')) THEN
  RAISE EXCEPTION 'Invalid submission fields' USING ERRCODE='22023'; END IF;
 normalized:=public.normalize_lead_intake_payload(p_payload);
 IF coalesce(normalized->>'phone','')='' AND coalesce(normalized->>'email','')='' THEN
  RAISE EXCEPTION 'Contact required' USING ERRCODE='22023'; END IF;
 event_key:=f.id::text||':'||p_submission::text;
 SELECT * INTO existing FROM public.lead_intake_envelopes WHERE provider='public_website_form' AND provider_event_id=event_key;
 IF FOUND THEN
  IF existing.shop_id IS DISTINCT FROM f.shop_id OR existing.payload IS DISTINCT FROM normalized THEN
   RAISE EXCEPTION 'Submission id reused with changed content' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('accepted',true);
 END IF;
 received:=clock_timestamp();
 -- Quotas are shop-wide so adding a form cannot multiply the allowance.
 IF (SELECT count(*) FROM public.lead_intake_envelopes WHERE shop_id=f.shop_id AND provider='public_website_form' AND received_at>received-interval '1 minute')>=30
 OR (SELECT count(*) FROM public.lead_intake_envelopes WHERE shop_id=f.shop_id AND provider='public_website_form' AND received_at>received-interval '24 hours')>=500 THEN
  RAISE EXCEPTION 'Submission limit reached' USING ERRCODE='PT429'; END IF;
 PERFORM public.record_lead_intake(f.shop_id,'website_form','public_website_form',event_key,received,NULL,NULL,normalized);
 -- Never disclose internal workflow ids or whether a person exists.
 RETURN jsonb_build_object('accepted',true);
END $$;

REVOKE ALL ON FUNCTION public.configure_public_intake_form(uuid,uuid,text,boolean,integer),public.list_public_intake_forms(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.configure_public_intake_form(uuid,uuid,text,boolean,integer),public.list_public_intake_forms(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.public_intake_form_origin(uuid,text),public.submit_public_intake_form(uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.public_intake_form_origin(uuid,text),public.submit_public_intake_form(uuid,text,uuid,jsonb) TO service_role;
COMMIT;
