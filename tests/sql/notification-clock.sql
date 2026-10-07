-- Disposable test stack only. Never install in an application environment.
CREATE OR REPLACE FUNCTION public.test_notification_clock(p_id uuid,p_mode text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR p_mode NOT IN ('due','expired','stale') THEN RAISE EXCEPTION 'Test clock unavailable'; END IF;
 UPDATE public.manager_notification_deliveries d SET
 next_attempt_at=CASE WHEN p_mode IN ('due','expired') THEN clock_timestamp()-interval '1 minute' ELSE next_attempt_at END,
 created_at=CASE WHEN p_mode='expired' THEN clock_timestamp()-interval '25 hours' ELSE created_at END,
 claimed_at=CASE WHEN p_mode='stale' THEN clock_timestamp()-interval '11 minutes' ELSE claimed_at END
 WHERE d.id=p_id AND EXISTS(SELECT 1 FROM public.shops s WHERE s.id=d.shop_id AND s.name='Integration Test Shop');
END $$;
REVOKE ALL ON FUNCTION public.test_notification_clock(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.test_notification_clock(uuid,text) TO service_role;
