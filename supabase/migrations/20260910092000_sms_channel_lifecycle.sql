BEGIN;
CREATE FUNCTION public.record_sms_keyword(p_shop uuid,p_customer uuid,p_destination text,p_opted_in boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE dest text=public.canonical_contact_destination('sms',p_destination);
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Verified webhook required' USING ERRCODE='42501'; END IF;
 IF dest IS NULL OR NOT EXISTS(SELECT 1 FROM public.customers WHERE shop_id=p_shop AND id=p_customer AND public.canonical_contact_destination('sms',phone)=dest) THEN RAISE EXCEPTION 'SMS destination does not belong to customer'; END IF;
 PERFORM id FROM public.customers WHERE shop_id=p_shop AND id=p_customer FOR UPDATE;
 UPDATE public.customers SET sms_opted_out_at=CASE WHEN p_opted_in THEN NULL ELSE now() END WHERE shop_id=p_shop AND id=p_customer;
 INSERT INTO public.customer_channel_permissions(shop_id,customer_id,channel,destination,suppressed_at,suppression_source,marketing_consent_at,consent_source)
 VALUES(p_shop,p_customer,'sms',dest,CASE WHEN p_opted_in THEN NULL ELSE now() END,CASE WHEN p_opted_in THEN NULL ELSE 'sms_keyword' END,CASE WHEN p_opted_in THEN now() ELSE NULL END,'sms_keyword')
 ON CONFLICT(shop_id,customer_id,channel,destination) DO UPDATE SET
 suppressed_at=CASE WHEN p_opted_in AND customer_channel_permissions.suppression_source='sms_keyword' THEN NULL WHEN p_opted_in THEN customer_channel_permissions.suppressed_at ELSE coalesce(customer_channel_permissions.suppressed_at,now()) END,
 suppression_source=CASE WHEN p_opted_in AND customer_channel_permissions.suppression_source='sms_keyword' THEN NULL WHEN customer_channel_permissions.suppressed_at IS NOT NULL THEN customer_channel_permissions.suppression_source WHEN NOT p_opted_in THEN 'sms_keyword' ELSE NULL END,
 marketing_consent_at=CASE WHEN p_opted_in THEN now() ELSE customer_channel_permissions.marketing_consent_at END,
 consent_source=CASE WHEN p_opted_in THEN 'sms_keyword' ELSE customer_channel_permissions.consent_source END;
END $$;
REVOKE ALL ON FUNCTION public.record_sms_keyword(uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_sms_keyword(uuid,uuid,text,boolean) TO service_role;
COMMIT;
