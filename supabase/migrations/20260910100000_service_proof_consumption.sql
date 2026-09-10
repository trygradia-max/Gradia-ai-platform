BEGIN;
-- Durable at-most-once authority. No customer/action FK: retain spent authority
-- after merges or action deletion; deletion must never make a proof reusable.
CREATE TABLE public.service_proof_consumptions (
 proof_id uuid PRIMARY KEY,
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 action_id uuid NOT NULL,
 claims jsonb NOT NULL,
 claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 UNIQUE(shop_id,action_id)
);
CREATE TABLE public.service_proof_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 proof_id uuid NOT NULL,
 action_id uuid NOT NULL,
 event text NOT NULL CHECK(event IN ('execution_claimed','execution_completed','same_action_retry','cross_action_replay_denied')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.service_proof_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_proof_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY proof_owner_read ON public.service_proof_consumptions FOR SELECT TO authenticated
 USING (EXISTS(SELECT 1 FROM public.shops WHERE id=shop_id AND owner_id=auth.uid()));
CREATE POLICY proof_audit_owner_read ON public.service_proof_audit FOR SELECT TO authenticated
 USING (EXISTS(SELECT 1 FROM public.shops WHERE id=shop_id AND owner_id=auth.uid()));
REVOKE ALL ON public.service_proof_consumptions,public.service_proof_audit FROM anon,authenticated;
GRANT SELECT ON public.service_proof_consumptions,public.service_proof_audit TO authenticated;

CREATE FUNCTION public.claim_service_execution(p_shop uuid,p_action uuid,p_pending boolean,p_claims jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE nonce uuid; inserted uuid; previous public.service_proof_consumptions; event_name text;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' AND NOT EXISTS(SELECT 1 FROM public.shops WHERE id=p_shop AND owner_id=auth.uid()) THEN
  RAISE EXCEPTION 'Proof claim not authorized' USING ERRCODE='42501';
 END IF;
 nonce=(p_claims->>'nonce')::uuid;
 IF nonce IS NULL OR p_action IS NULL OR p_pending IS NULL OR
    (p_claims->>'version') IS DISTINCT FROM '2' OR (p_claims->>'shopId') IS DISTINCT FROM p_shop::text OR
    COALESCE(p_claims->>'channel','') NOT IN ('sms','email') OR
    (p_claims->>'purpose') IS DISTINCT FROM ('service:' || (p_claims->'context'->>'kind')) OR
    COALESCE(p_claims->'context'->>'kind','') NOT IN ('reply','quote','appointment','payment') OR
    p_claims->'context'->>'id' IS NULL OR
    COALESCE(p_claims->>'contentHash','') !~ '^[0-9a-f]{64}$' OR
    COALESCE((p_claims->>'expires')::numeric,0) <= extract(epoch FROM clock_timestamp())*1000 OR
    ((p_claims->>'actionId') IS NOT NULL AND (p_claims->>'actionId') IS DISTINCT FROM p_action::text) OR
    NOT EXISTS(SELECT 1 FROM public.customers WHERE shop_id=p_shop AND id=(p_claims->>'customerId')::uuid AND do_not_contact=false AND CASE p_claims->>'channel' WHEN 'sms' THEN phone_canonical=p_claims->>'destination' AND sms_opted_out_at IS NULL ELSE email_canonical=p_claims->>'destination' END) THEN
  RAISE EXCEPTION 'Invalid proof claim';
 END IF;
 IF public.canonical_contact_destination(p_claims->>'channel',p_claims->>'destination') IS DISTINCT FROM p_claims->>'destination' OR p_claims->>'destination' IS NULL THEN RAISE EXCEPTION 'Invalid proof destination'; END IF;
 IF p_pending AND NOT EXISTS(SELECT 1 FROM public.pending_actions WHERE shop_id=p_shop AND id=p_action AND status='approved' AND action_type::text=CASE p_claims->>'channel' WHEN 'sms' THEN 'send_sms' ELSE 'send_email' END) THEN RAISE EXCEPTION 'Action cannot claim proof'; END IF;
 INSERT INTO public.service_proof_consumptions(proof_id,shop_id,action_id,claims)
 VALUES(nonce,p_shop,p_action,p_claims) ON CONFLICT DO NOTHING RETURNING proof_id INTO inserted;
 IF inserted IS NOT NULL THEN
  INSERT INTO public.service_proof_audit(shop_id,proof_id,action_id,event) VALUES(p_shop,nonce,p_action,'execution_claimed');
  RETURN 'claimed';
 END IF;
 -- Unique-index conflict waits for concurrent transactions. The subsequent read
 -- sees the durable winner; neither a new process nor a retry can reopen it.
 SELECT * INTO previous FROM public.service_proof_consumptions WHERE proof_id=nonce OR (shop_id=p_shop AND action_id=p_action) ORDER BY (proof_id=nonce) DESC LIMIT 1;
 event_name=CASE WHEN previous.shop_id=p_shop AND previous.action_id=p_action AND previous.proof_id=nonce THEN 'same_action_retry' ELSE 'cross_action_replay_denied' END;
 INSERT INTO public.service_proof_audit(shop_id,proof_id,action_id,event) VALUES(p_shop,nonce,p_action,event_name);
 RETURN event_name;
END $$;

CREATE FUNCTION public.complete_service_execution(p_shop uuid,p_action uuid,p_nonce uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' AND NOT EXISTS(SELECT 1 FROM public.shops WHERE id=p_shop AND owner_id=auth.uid()) THEN RAISE EXCEPTION 'Proof completion not authorized' USING ERRCODE='42501'; END IF;
 UPDATE public.service_proof_consumptions SET completed_at=clock_timestamp() WHERE shop_id=p_shop AND action_id=p_action AND proof_id=p_nonce AND completed_at IS NULL;
 IF FOUND THEN INSERT INTO public.service_proof_audit(shop_id,proof_id,action_id,event) VALUES(p_shop,p_nonce,p_action,'execution_completed'); END IF;
END $$;
CREATE FUNCTION public.audit_service_action_retry(p_shop uuid,p_action uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' AND NOT EXISTS(SELECT 1 FROM public.shops WHERE id=p_shop AND owner_id=auth.uid()) THEN RAISE EXCEPTION 'Proof audit not authorized' USING ERRCODE='42501'; END IF;
 INSERT INTO public.service_proof_audit(shop_id,proof_id,action_id,event)
 SELECT shop_id,proof_id,action_id,'same_action_retry' FROM public.service_proof_consumptions WHERE shop_id=p_shop AND action_id=p_action;
END $$;
REVOKE ALL ON FUNCTION public.claim_service_execution(uuid,uuid,boolean,jsonb),public.complete_service_execution(uuid,uuid,uuid),public.audit_service_action_retry(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.claim_service_execution(uuid,uuid,boolean,jsonb),public.complete_service_execution(uuid,uuid,uuid),public.audit_service_action_retry(uuid,uuid) TO authenticated,service_role;
COMMIT;
