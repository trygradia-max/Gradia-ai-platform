BEGIN;
-- Retain original consent evidence even when duplicate rows must be reconciled.
CREATE TABLE public.customer_merge_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 winner_id uuid NOT NULL,
 loser_id uuid NOT NULL,
 evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.customer_merge_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY merge_history_owner_read ON public.customer_merge_history FOR SELECT TO authenticated
 USING (shop_id IN (SELECT id FROM public.shops WHERE owner_id=auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.customer_merge_history FROM authenticated, anon;

CREATE FUNCTION public.merge_customer_json(value jsonb, loser uuid, winner uuid) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE jsonb_typeof(value)
 WHEN 'object' THEN COALESCE((SELECT jsonb_object_agg(key, CASE WHEN key='customer_id' AND val=to_jsonb(loser::text) THEN to_jsonb(winner::text) ELSE public.merge_customer_json(val,loser,winner) END) FROM jsonb_each(value) e(key,val)), '{}'::jsonb)
 WHEN 'array' THEN COALESCE((SELECT jsonb_agg(public.merge_customer_json(val,loser,winner) ORDER BY ordinal) FROM jsonb_array_elements(value) WITH ORDINALITY e(val,ordinal)), '[]'::jsonb)
 ELSE value END;
$$;

CREATE FUNCTION public.merge_customers_atomic(p_shop uuid,p_winner uuid,p_loser uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w public.customers; l public.customers; t text; n integer; moved jsonb='{}'; r public.customer_channel_permissions;
BEGIN
 IF p_winner=p_loser OR p_winner IS NULL OR p_loser IS NULL THEN RAISE EXCEPTION 'Pick two different customers'; END IF;
 IF auth.role() IS DISTINCT FROM 'service_role' AND NOT EXISTS (SELECT 1 FROM public.shops WHERE id=p_shop AND owner_id=auth.uid()) THEN RAISE EXCEPTION 'Merge not authorized' USING ERRCODE='42501'; END IF;
 -- Deterministic locks serialize both merge directions and parent FK writers.
 PERFORM id FROM public.customers WHERE shop_id=p_shop AND id IN(p_winner,p_loser) ORDER BY id FOR UPDATE;
 SELECT * INTO w FROM public.customers WHERE shop_id=p_shop AND id=p_winner;
 SELECT * INTO l FROM public.customers WHERE shop_id=p_shop AND id=p_loser;
 IF w.id IS NULL OR l.id IS NULL THEN RAISE EXCEPTION 'Both customers must belong to this shop'; END IF;
 PERFORM id FROM public.customer_channel_permissions WHERE shop_id=p_shop AND customer_id IN(p_winner,p_loser) ORDER BY id FOR UPDATE;
 INSERT INTO public.customer_merge_history(shop_id,winner_id,loser_id,evidence)
 VALUES(p_shop,p_winner,p_loser,jsonb_build_object('winner',to_jsonb(w),'loser',to_jsonb(l),'permissions',COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM public.customer_channel_permissions p WHERE shop_id=p_shop AND customer_id IN(p_winner,p_loser)),'[]'::jsonb)));
 FOR r IN SELECT * FROM public.customer_channel_permissions WHERE shop_id=p_shop AND customer_id=p_loser LOOP
   INSERT INTO public.customer_channel_permissions(shop_id,customer_id,channel,destination,suppressed_at,suppression_source,marketing_consent_at,consent_source,created_at)
   VALUES(p_shop,p_winner,r.channel,r.destination,r.suppressed_at,r.suppression_source,r.marketing_consent_at,r.consent_source,r.created_at)
   ON CONFLICT(shop_id,customer_id,channel,destination) DO UPDATE SET
    suppression_source=CASE WHEN customer_channel_permissions.suppressed_at IS NULL THEN EXCLUDED.suppression_source WHEN EXCLUDED.suppressed_at IS NOT NULL AND customer_channel_permissions.suppression_source IS DISTINCT FROM EXCLUDED.suppression_source THEN NULL ELSE customer_channel_permissions.suppression_source END,
    suppressed_at=greatest(customer_channel_permissions.suppressed_at,EXCLUDED.suppressed_at),
    marketing_consent_at=CASE WHEN customer_channel_permissions.marketing_consent_at IS NOT NULL AND EXCLUDED.marketing_consent_at IS NOT NULL THEN least(customer_channel_permissions.marketing_consent_at,EXCLUDED.marketing_consent_at) ELSE NULL END;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['leads','interactions','appointments','vehicles','quotes','payments','call_records','automation_runs'] LOOP
   EXECUTE format('UPDATE public.%I SET customer_id=$1 WHERE shop_id=$2 AND customer_id=$3',t) USING p_winner,p_shop,p_loser;
   GET DIAGNOSTICS n=ROW_COUNT; moved=moved || jsonb_build_object(t,n);
 END LOOP;
 UPDATE public.pending_actions SET payload=public.merge_customer_json(payload,p_loser,p_winner)
 WHERE shop_id=p_shop AND payload IS DISTINCT FROM public.merge_customer_json(payload,p_loser,p_winner);
 UPDATE public.interactions SET metadata=public.merge_customer_json(metadata,p_loser,p_winner)
 WHERE shop_id=p_shop AND metadata IS DISTINCT FROM public.merge_customer_json(metadata,p_loser,p_winner);
 -- Free unique identifiers inside the same transaction; failures roll back all steps.
 UPDATE public.customers SET phone=NULL,email=NULL WHERE id=p_loser AND shop_id=p_shop;
 UPDATE public.customers SET name=coalesce(w.name,l.name), phone=coalesce(w.phone,l.phone),email=coalesce(w.email,l.email),
  do_not_contact=coalesce(w.do_not_contact,true) OR coalesce(l.do_not_contact,true),
  sms_opted_out_at=greatest(w.sms_opted_out_at,l.sms_opted_out_at)
 WHERE id=p_winner AND shop_id=p_shop;
 DELETE FROM public.customers WHERE id=p_loser AND shop_id=p_shop;
 RETURN moved;
END $$;
REVOKE ALL ON FUNCTION public.merge_customers_atomic(uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.merge_customers_atomic(uuid,uuid,uuid) TO authenticated,service_role;
COMMIT;
