BEGIN;
CREATE TABLE public.manager_notification_settings (
 shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
 mode text NOT NULL CHECK(mode IN ('off','immediate','digest')),
 timezone text NOT NULL, quiet_start integer NOT NULL CHECK(quiet_start BETWEEN 0 AND 23),
 quiet_end integer NOT NULL CHECK(quiet_end BETWEEN 0 AND 23), digest_hour integer NOT NULL CHECK(digest_hour BETWEEN 0 AND 23),
 revision integer NOT NULL, updated_by uuid NOT NULL, enabled_since timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.manager_notification_settings_audit (
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE, revision integer NOT NULL,
 actor_id uuid NOT NULL, settings jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(shop_id,revision)
);
CREATE TABLE public.manager_notification_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 recipient_id uuid NOT NULL, recipient_email text NOT NULL, sender_email text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('immediate','digest')), local_day date NOT NULL,
 settings_revision integer NOT NULL, item_count integer NOT NULL CHECK(item_count BETWEEN 1 AND 50),
 subject text NOT NULL, body text NOT NULL,
 state text NOT NULL CHECK(state IN ('claimed','accepted','retry','unknown','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 1 CHECK(attempts BETWEEN 1 AND 3),
 claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(), next_attempt_at timestamptz,
 provider_id text, reason text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(shop_id,id), FOREIGN KEY(shop_id,recipient_id) REFERENCES public.shop_memberships(shop_id,user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX manager_notification_daily_digest ON public.manager_notification_deliveries(shop_id,recipient_id,local_day) WHERE mode='digest';
CREATE UNIQUE INDEX conversation_notifications_shop_id_id_unique ON public.conversation_notifications(shop_id,id);
CREATE TABLE public.manager_notification_items (
 notification_id uuid PRIMARY KEY, shop_id uuid NOT NULL, delivery_id uuid NOT NULL,
 FOREIGN KEY(shop_id,notification_id) REFERENCES public.conversation_notifications(shop_id,id) ON DELETE CASCADE,
 FOREIGN KEY(shop_id,delivery_id) REFERENCES public.manager_notification_deliveries(shop_id,id) ON DELETE CASCADE
);
ALTER TABLE public.manager_notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manager_notification_settings_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manager_notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manager_notification_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.manager_notification_settings,public.manager_notification_settings_audit,public.manager_notification_deliveries,public.manager_notification_items FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.configure_manager_notifications(p_shop uuid,p_revision integer,p_mode text,p_timezone text,p_quiet_start integer,p_quiet_end integer,p_digest_hour integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE previous public.manager_notification_settings; next_revision integer;
BEGIN
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 IF auth.uid() IS NULL OR NOT public.team_is_owner(p_shop) OR NOT EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND active) THEN RAISE EXCEPTION 'Settings unavailable' USING ERRCODE='42501'; END IF;
 IF p_revision IS NULL OR p_revision<0 OR p_revision>=2147483647 OR p_mode IS NULL OR p_mode NOT IN ('off','immediate','digest')
 OR p_timezone IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=p_timezone)
 OR p_quiet_start IS NULL OR p_quiet_start NOT BETWEEN 0 AND 23 OR p_quiet_end IS NULL OR p_quiet_end NOT BETWEEN 0 AND 23
 OR p_digest_hour IS NULL OR p_digest_hour NOT BETWEEN 0 AND 23 THEN RAISE EXCEPTION 'Invalid settings' USING ERRCODE='22023'; END IF;
 SELECT * INTO previous FROM public.manager_notification_settings WHERE shop_id=p_shop;
 IF coalesce(previous.revision,0)<>p_revision THEN RAISE EXCEPTION 'Settings changed; refresh' USING ERRCODE='PT409'; END IF;
 next_revision:=p_revision+1;
 INSERT INTO public.manager_notification_settings VALUES(p_shop,p_mode,p_timezone,p_quiet_start,p_quiet_end,p_digest_hour,next_revision,auth.uid(),clock_timestamp())
 ON CONFLICT(shop_id) DO UPDATE SET mode=EXCLUDED.mode,timezone=EXCLUDED.timezone,quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,digest_hour=EXCLUDED.digest_hour,revision=EXCLUDED.revision,updated_by=EXCLUDED.updated_by,
 enabled_since=CASE WHEN manager_notification_settings.mode='off' THEN EXCLUDED.enabled_since ELSE manager_notification_settings.enabled_since END;
 INSERT INTO public.manager_notification_settings_audit(shop_id,revision,actor_id,settings) VALUES(p_shop,next_revision,auth.uid(),jsonb_build_object('mode',p_mode,'timezone',p_timezone,'quiet_start',p_quiet_start,'quiet_end',p_quiet_end,'digest_hour',p_digest_hour));
 RETURN next_revision;
END $$;

CREATE FUNCTION public.read_manager_notifications(p_shop uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE settings jsonb; history jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT public.team_is_owner(p_shop) OR NOT EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND active) THEN RAISE EXCEPTION 'Settings unavailable' USING ERRCODE='42501'; END IF;
 SELECT to_jsonb(s)-'shop_id'-'updated_by'-'enabled_since' INTO settings FROM public.manager_notification_settings s WHERE shop_id=p_shop;
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC),'[]') INTO history FROM (
  SELECT d.id,d.state,d.attempts,d.item_count,d.reason,d.created_at,m.display_name AS recipient FROM public.manager_notification_deliveries d JOIN public.shop_memberships m ON m.shop_id=d.shop_id AND m.user_id=d.recipient_id WHERE d.shop_id=p_shop ORDER BY d.created_at DESC,d.id DESC LIMIT 20
 ) q;
 RETURN jsonb_build_object('settings',coalesce(settings,jsonb_build_object('mode','off','timezone','UTC','quiet_start',21,'quiet_end',8,'digest_hour',9,'revision',0)),'history',history);
END $$;

-- Deliberately not attached to any cron or public endpoint. Global runtime gate is
-- also required by the worker before calling this service-only command.
CREATE FUNCTION public.claim_manager_notification(p_shop uuid,p_sender text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE prefs public.manager_notification_settings; job public.manager_notification_deliveries; recipient uuid; destination text; ids uuid[]; hour integer; day date; amount integer;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='42501'; END IF;
 IF p_sender IS NULL OR public.canonical_contact_destination('email',p_sender) IS DISTINCT FROM p_sender THEN RAISE EXCEPTION 'Sender unavailable' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 SELECT * INTO prefs FROM public.manager_notification_settings WHERE shop_id=p_shop;
 UPDATE public.manager_notification_deliveries SET state='unknown',reason='claim_expired' WHERE shop_id=p_shop AND state='claimed' AND claimed_at<clock_timestamp()-interval '10 minutes';
 IF prefs.shop_id IS NULL OR prefs.mode='off' THEN RETURN NULL; END IF;
 hour:=extract(hour FROM clock_timestamp() AT TIME ZONE prefs.timezone); day:=(clock_timestamp() AT TIME ZONE prefs.timezone)::date;
 IF (prefs.quiet_start<prefs.quiet_end AND hour>=prefs.quiet_start AND hour<prefs.quiet_end)
 OR (prefs.quiet_start>prefs.quiet_end AND (hour>=prefs.quiet_start OR hour<prefs.quiet_end)) THEN RETURN NULL; END IF;
 SELECT * INTO job FROM public.manager_notification_deliveries WHERE shop_id=p_shop AND state='retry' AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE;
 IF job.id IS NOT NULL THEN
  SELECT public.canonical_contact_destination('email',u.email) INTO destination FROM public.shop_memberships m JOIN auth.users u ON u.id=m.user_id JOIN public.shops s ON s.id=m.shop_id
   WHERE m.shop_id=p_shop AND m.user_id=job.recipient_id AND m.active AND u.email_confirmed_at IS NOT NULL
   AND ((m.role='owner' AND s.owner_id=m.user_id) OR (m.role='manager' AND 'crm.read'=ANY(m.capabilities)));
  IF destination IS NULL OR destination IS DISTINCT FROM job.recipient_email OR job.sender_email IS DISTINCT FROM p_sender OR job.settings_revision<>prefs.revision OR job.created_at<clock_timestamp()-interval '23 hours'
   OR job.item_count<>(SELECT count(*) FROM public.manager_notification_items x JOIN public.conversation_notifications n ON n.shop_id=x.shop_id AND n.id=x.notification_id
    WHERE x.shop_id=p_shop AND x.delivery_id=job.id AND NOT EXISTS(SELECT 1 FROM public.conversation_reads r WHERE r.shop_id=p_shop AND r.customer_id=n.customer_id AND r.channel=n.channel AND r.user_id=n.recipient_id AND r.acknowledged_at>=n.created_at)) THEN
   UPDATE public.manager_notification_deliveries SET state='cancelled',reason='authority_or_configuration_changed' WHERE id=job.id; RETURN NULL;
  END IF;
  UPDATE public.manager_notification_deliveries SET state='claimed',attempts=attempts+1,claimed_at=clock_timestamp(),next_attempt_at=NULL WHERE id=job.id RETURNING * INTO job;
  RETURN to_jsonb(job);
 END IF;
 IF prefs.mode='digest' AND hour<prefs.digest_hour THEN RETURN NULL; END IF;
 SELECT n.recipient_id,public.canonical_contact_destination('email',u.email) INTO recipient,destination FROM public.conversation_notifications n
 JOIN public.shop_memberships m ON m.shop_id=n.shop_id AND m.user_id=n.recipient_id
 JOIN auth.users u ON u.id=m.user_id JOIN public.shops s ON s.id=m.shop_id
 WHERE n.shop_id=p_shop AND n.created_at>=prefs.enabled_since AND m.active AND u.email_confirmed_at IS NOT NULL
 AND public.canonical_contact_destination('email',u.email) IS NOT NULL
 AND ((m.role='owner' AND s.owner_id=m.user_id) OR (m.role='manager' AND 'crm.read'=ANY(m.capabilities)))
 AND NOT EXISTS(SELECT 1 FROM public.manager_notification_items x WHERE x.notification_id=n.id)
 AND NOT EXISTS(SELECT 1 FROM public.conversation_reads r WHERE r.shop_id=p_shop AND r.customer_id=n.customer_id AND r.channel=n.channel AND r.user_id=n.recipient_id AND r.acknowledged_at>=n.created_at)
 AND (prefs.mode<>'digest' OR NOT EXISTS(SELECT 1 FROM public.manager_notification_deliveries d WHERE d.shop_id=p_shop AND d.recipient_id=n.recipient_id AND d.mode='digest' AND d.local_day=day))
 ORDER BY n.created_at,n.id LIMIT 1;
 IF recipient IS NULL THEN RETURN NULL; END IF;
 SELECT array_agg(id ORDER BY created_at,id) INTO ids FROM (
  SELECT n.id,n.created_at FROM public.conversation_notifications n WHERE n.shop_id=p_shop AND n.recipient_id=recipient AND n.created_at>=prefs.enabled_since
  AND NOT EXISTS(SELECT 1 FROM public.manager_notification_items x WHERE x.notification_id=n.id)
  AND NOT EXISTS(SELECT 1 FROM public.conversation_reads r WHERE r.shop_id=p_shop AND r.customer_id=n.customer_id AND r.channel=n.channel AND r.user_id=recipient AND r.acknowledged_at>=n.created_at)
  ORDER BY n.created_at,n.id LIMIT CASE WHEN prefs.mode='digest' THEN 50 ELSE 1 END
 ) q;
 amount:=cardinality(ids);
 INSERT INTO public.manager_notification_deliveries(shop_id,recipient_id,recipient_email,sender_email,mode,local_day,settings_revision,item_count,subject,body,state)
 VALUES(p_shop,recipient,destination,p_sender,prefs.mode,day,prefs.revision,amount,'Gradia: conversation work needs review',
  amount::text||' conversation update(s) await review. Open your Gradia workspace: https://gradia-ai-platform.vercel.app/conversations?shop='||p_shop::text||E'\nThis is an operational notification, not a customer message.','claimed') RETURNING * INTO job;
 INSERT INTO public.manager_notification_items(notification_id,shop_id,delivery_id) SELECT unnest(ids),p_shop,job.id;
 RETURN to_jsonb(job);
END $$;

CREATE FUNCTION public.finish_manager_notification(p_shop uuid,p_id uuid,p_attempt integer,p_outcome text,p_provider_id text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE job public.manager_notification_deliveries;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='42501'; END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN ('accepted','retry','unknown','failed') OR (p_outcome='accepted' AND (p_provider_id IS NULL OR char_length(p_provider_id) NOT BETWEEN 1 AND 200)) THEN RAISE EXCEPTION 'Invalid result' USING ERRCODE='22023'; END IF;
 SELECT * INTO job FROM public.manager_notification_deliveries WHERE shop_id=p_shop AND id=p_id FOR UPDATE;
 IF job.id IS NULL OR job.state<>'claimed' OR job.attempts IS DISTINCT FROM p_attempt THEN RETURN false; END IF;
 UPDATE public.manager_notification_deliveries SET state=CASE WHEN p_outcome='retry' AND attempts>=3 THEN 'failed' ELSE p_outcome END,
  reason=CASE p_outcome WHEN 'retry' THEN 'rate_limited' WHEN 'unknown' THEN 'unknown_outcome' WHEN 'failed' THEN 'provider_rejected' ELSE NULL END,
  provider_id=CASE WHEN p_outcome='accepted' THEN p_provider_id ELSE NULL END,
  next_attempt_at=CASE WHEN p_outcome='retry' AND attempts<3 THEN clock_timestamp()+interval '5 minutes'*attempts ELSE NULL END
 WHERE id=job.id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.configure_manager_notifications(uuid,integer,text,text,integer,integer,integer),public.read_manager_notifications(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.configure_manager_notifications(uuid,integer,text,text,integer,integer,integer),public.read_manager_notifications(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.claim_manager_notification(uuid,text),public.finish_manager_notification(uuid,uuid,integer,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_manager_notification(uuid,text),public.finish_manager_notification(uuid,uuid,integer,text,text) TO service_role;
COMMIT;
