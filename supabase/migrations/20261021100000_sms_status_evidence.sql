BEGIN;
-- Callback-before-interaction recovery for SMS delivery status.
--
-- Twilio can post a message's status (even its terminal outcome) before the
-- send path has saved the outbound interaction. The status route used to
-- acknowledge such a callback and write nothing, so an early terminal result
-- was lost. Now, AFTER the signature has been verified with the shop's own
-- credentials, the route stores the callback here, keyed by the verified shop
-- and the provider MessageSid. When the shop's outbound interaction with that
-- SID is written (by any send path), a trigger applies the evidence to it with
-- the same rules as the route (#99): status only moves forward, the first
-- terminal outcome stays, and a contradicting terminal outcome is kept as
-- metadata.twilio_status_conflict.
--
-- Evidence is never an interaction, never binds a customer, never resends and
-- grants nothing: it only updates delivery-status metadata. It is scoped by
-- shop, so a SID claimed by one shop's signer is invisible to another shop.
-- Additive: one new table and functions, one new trigger on interactions.
-- Existing rows are unchanged.

-- Delivery rank, mirroring src/lib/twilio-delivery-status.ts exactly.
CREATE FUNCTION public.sms_delivery_rank(p_status text) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE lower(p_status)
  WHEN 'accepted' THEN 0 WHEN 'scheduled' THEN 0 WHEN 'queued' THEN 1 WHEN 'sending' THEN 2 WHEN 'sent' THEN 3
  WHEN 'delivered' THEN 4 WHEN 'undelivered' THEN 4 WHEN 'failed' THEN 4 WHEN 'canceled' THEN 4 WHEN 'read' THEN 5
  ELSE NULL END;
$$;

-- Applies one status to delivery metadata, as advancesDeliveryStatus /
-- conflictingTerminalOutcome do in the route. Returns the metadata unchanged
-- when the status is stale, a replay, or unknown.
CREATE FUNCTION public.sms_delivery_merge(p_meta jsonb,p_status text,p_error text,p_at timestamptz) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE cur text:=p_meta->>'twilio_status'; f integer; t integer; prior jsonb:=p_meta->'twilio_status_conflict';
 failed text[]:=ARRAY['undelivered','failed','canceled'];
BEGIN
 IF p_status IS NULL THEN RETURN p_meta; END IF;
 f:=public.sms_delivery_rank(cur); t:=public.sms_delivery_rank(p_status);
 -- Advances: an unknown status only fills an empty one; read only follows delivered.
 IF (t IS NULL AND cur IS NULL)
  OR (t IS NOT NULL AND NOT (lower(p_status)='read' AND lower(coalesce(cur,''))=ANY(failed)) AND (f IS NULL OR t>f)) THEN
  RETURN p_meta||jsonb_build_object('twilio_status',p_status,'twilio_status_updated_at',p_at)
   ||CASE WHEN p_error IS NOT NULL THEN jsonb_build_object('twilio_error_code',p_error) ELSE '{}'::jsonb END;
 END IF;
 -- Conflict: both terminal, one says arrived and the other says not.
 IF f IS NOT NULL AND t IS NOT NULL AND f>=4 AND t>=4 AND (lower(cur)=ANY(failed))<>(lower(p_status)=ANY(failed)) THEN
  IF prior->>'status' IS NOT DISTINCT FROM p_status AND prior->>'error_code' IS NOT DISTINCT FROM p_error THEN RETURN p_meta; END IF;
  RETURN p_meta||jsonb_build_object('twilio_status_conflict',jsonb_build_object('status',p_status,'error_code',p_error,'received_at',p_at));
 END IF;
 RETURN p_meta;
END $$;

CREATE TABLE public.sms_status_evidence (
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 message_sid text NOT NULL CHECK (message_sid ~ '^(SM|MM)[0-9a-fA-F]{32}$'),
 -- Delivery metadata accumulated from callbacks, in the interaction's shape.
 state jsonb NOT NULL DEFAULT '{}'::jsonb,
 callbacks integer NOT NULL DEFAULT 0 CHECK (callbacks>=0),
 first_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 applied_interaction_id uuid,
 applied_at timestamptz,
 PRIMARY KEY (shop_id,message_sid)
);
ALTER TABLE public.sms_status_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sms_status_evidence FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.sms_status_lock(p_shop uuid,p_sid text) RETURNS void LANGUAGE sql SET search_path='' AS $$
 SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_shop::text||':'||p_sid,0));
$$;

-- Called by the status route only after the signature verified with the
-- shop's own credentials, when no outbound interaction carries the SID yet.
-- Serialized with the interaction trigger on the same lock. Returns
-- 'interaction_exists' (the route applies the status to it), 'stored', or
-- 'unchanged' (a replay or stale status). Any error raises: the route
-- returns 5xx and Twilio retries.
CREATE FUNCTION public.record_sms_status_evidence(p_shop uuid,p_sid text,p_status text,p_error text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE ev public.sms_status_evidence; merged jsonb; now_at timestamptz:=clock_timestamp();
BEGIN
 IF p_shop IS NULL OR p_sid IS NULL OR p_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$' OR p_status IS NULL OR p_status !~ '^[a-z_]{1,32}$'
  OR (p_error IS NOT NULL AND p_error !~ '^[0-9A-Za-z_-]{1,16}$') THEN
  RAISE EXCEPTION 'Invalid status evidence' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.shops WHERE id=p_shop) THEN RAISE EXCEPTION 'Unknown shop' USING ERRCODE='22023'; END IF;
 PERFORM public.sms_status_lock(p_shop,p_sid);
 IF EXISTS(SELECT 1 FROM public.interactions i WHERE i.shop_id=p_shop AND i.channel='sms' AND i.role='gradia'
  AND i.metadata->>'twilio_message_sid'=p_sid) THEN RETURN 'interaction_exists'; END IF;
 SELECT * INTO ev FROM public.sms_status_evidence WHERE shop_id=p_shop AND message_sid=p_sid FOR UPDATE;
 IF ev.shop_id IS NULL THEN
  INSERT INTO public.sms_status_evidence(shop_id,message_sid,state,callbacks,first_received_at,last_received_at)
  VALUES (p_shop,p_sid,public.sms_delivery_merge('{}'::jsonb,p_status,p_error,now_at),1,now_at,now_at);
  RETURN 'stored';
 END IF;
 merged:=public.sms_delivery_merge(ev.state,p_status,p_error,now_at);
 UPDATE public.sms_status_evidence SET state=merged,callbacks=callbacks+1,last_received_at=now_at
  WHERE shop_id=p_shop AND message_sid=p_sid;
 RETURN CASE WHEN merged=ev.state THEN 'unchanged' ELSE 'stored' END;
END $$;

-- When an outbound SMS interaction with a SID is written (insert, or the SID
-- added later) by any send path, apply the shop's waiting evidence for that
-- SID: its status, then any conflicting terminal outcome. Same lock as above.
CREATE FUNCTION public.interactions_apply_sms_status_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sid text:=NEW.metadata->>'twilio_message_sid'; ev public.sms_status_evidence; merged jsonb;
BEGIN
 IF NEW.channel<>'sms' OR NEW.role<>'gradia' OR sid IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.metadata->>'twilio_message_sid' IS NOT DISTINCT FROM sid THEN RETURN NEW; END IF;
 PERFORM public.sms_status_lock(NEW.shop_id,sid);
 SELECT * INTO ev FROM public.sms_status_evidence WHERE shop_id=NEW.shop_id AND message_sid=sid AND applied_interaction_id IS NULL FOR UPDATE;
 IF ev.shop_id IS NULL THEN RETURN NEW; END IF;
 merged:=public.sms_delivery_merge(NEW.metadata,ev.state->>'twilio_status',ev.state->>'twilio_error_code',
  coalesce((ev.state->>'twilio_status_updated_at')::timestamptz,ev.last_received_at));
 IF ev.state ? 'twilio_status_conflict' THEN
  merged:=public.sms_delivery_merge(merged,ev.state->'twilio_status_conflict'->>'status',ev.state->'twilio_status_conflict'->>'error_code',
   coalesce((ev.state->'twilio_status_conflict'->>'received_at')::timestamptz,ev.last_received_at));
 END IF;
 NEW.metadata:=merged||jsonb_build_object('twilio_status_evidence_applied_at',clock_timestamp());
 UPDATE public.sms_status_evidence SET applied_interaction_id=NEW.id,applied_at=clock_timestamp()
  WHERE shop_id=NEW.shop_id AND message_sid=sid;
 RETURN NEW;
END $$;
CREATE TRIGGER interactions_sms_status_evidence BEFORE INSERT OR UPDATE OF metadata ON public.interactions
 FOR EACH ROW EXECUTE FUNCTION public.interactions_apply_sms_status_evidence();

REVOKE ALL ON FUNCTION public.sms_delivery_rank(text),public.sms_delivery_merge(jsonb,text,text,timestamptz),public.sms_status_lock(uuid,text),
 public.interactions_apply_sms_status_evidence(),public.record_sms_status_evidence(uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_sms_status_evidence(uuid,text,text,text) TO service_role;

-- Keep a private-review database frozen when adding this table.
DO $$ BEGIN
 IF to_regprocedure('gradia_release_guard.reject_application_writes()') IS NOT NULL THEN
  CREATE TRIGGER gradia_release_freeze BEFORE INSERT OR UPDATE OR DELETE ON public.sms_status_evidence
   FOR EACH STATEMENT EXECUTE FUNCTION gradia_release_guard.reject_application_writes();
  ALTER TABLE public.sms_status_evidence ENABLE ALWAYS TRIGGER gradia_release_freeze;
 END IF;
END $$;
COMMIT;
