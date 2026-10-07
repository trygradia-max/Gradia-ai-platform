BEGIN;
CREATE UNIQUE INDEX interactions_shop_id_id_unique ON public.interactions(shop_id,id);
CREATE TABLE public.email_reply_evidence (
 shop_id uuid NOT NULL, interaction_id uuid NOT NULL,
 account_id bigint NOT NULL CHECK(account_id>0),
 message_id text NOT NULL CHECK(char_length(message_id) BETWEEN 1 AND 1024 AND message_id ~ '^[A-Za-z0-9_+=.-]+$' AND message_id NOT IN ('.','..')),
 thread_id text CHECK(thread_id IS NULL OR (char_length(thread_id) BETWEEN 1 AND 1024 AND thread_id !~ '[[:cntrl:]]')),
 binding jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(shop_id,interaction_id),
 FOREIGN KEY(shop_id,interaction_id) REFERENCES public.interactions(shop_id,id) ON DELETE CASCADE
);
ALTER TABLE public.email_reply_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_reply_evidence FROM PUBLIC,anon,authenticated,service_role;
GRANT INSERT ON public.email_reply_evidence TO service_role;
CREATE FUNCTION public.bind_email_reply_evidence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE i public.interactions;
BEGIN
 SELECT * INTO i FROM public.interactions WHERE shop_id=NEW.shop_id AND id=NEW.interaction_id;
 IF auth.role() IS DISTINCT FROM 'service_role' OR i.id IS NULL OR i.channel::text<>'email' OR i.role::text<>'customer'
  OR i.metadata->>'direction' IS DISTINCT FROM 'inbound' OR i.customer_id IS NULL
  OR NEW.account_id IS DISTINCT FROM (SELECT aurinko_account_id FROM public.shops WHERE id=NEW.shop_id)
  OR i.metadata->>'aurinko_message_id' IS DISTINCT FROM NEW.message_id
  OR public.canonical_contact_destination('email',i.metadata->>'from_email') IS NULL
 THEN RAISE EXCEPTION 'Mailbox evidence unavailable' USING ERRCODE='42501'; END IF;
 NEW.binding:=jsonb_build_object('customer',i.customer_id,'content',i.content,'created_at',i.created_at,'from',i.metadata->>'from_email');
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.bind_email_reply_evidence() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER bind_email_reply_evidence BEFORE INSERT ON public.email_reply_evidence FOR EACH ROW EXECUTE FUNCTION public.bind_email_reply_evidence();
CREATE OR REPLACE FUNCTION public.whisper_reply_context(p_shop uuid,p_action uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE a public.pending_actions; h public.conversation_audit; c public.customers; destination text; inbound public.interactions; evidence public.email_reply_evidence; reply jsonb;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' AND NOT (
  public.team_is_owner(p_shop) AND EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND active)
 ) THEN RAISE EXCEPTION 'Reply review unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM public.pending_actions WHERE shop_id=p_shop AND id=p_action;
 IF a.id IS NULL OR a.action_type::text NOT IN ('send_sms','send_email') THEN RAISE EXCEPTION 'Message unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO h FROM public.conversation_audit WHERE command_id=p_action AND shop_id=p_shop AND operation='reply';
 IF h.command_id IS NULL THEN
  IF a.payload->>'source'='whisper_inbox' THEN RAISE EXCEPTION 'Conversation evidence unavailable' USING ERRCODE='42501'; END IF;
  RETURN NULL; -- A legacy producer; its existing purpose rules remain in force.
 END IF;
 SELECT * INTO c FROM public.customers WHERE shop_id=p_shop AND id=h.customer_id;
 destination:=public.canonical_contact_destination(h.channel,h.binding->'payload'->>'destination');
 IF c.id IS NULL OR h.channel NOT IN ('sms','email')
 OR a.action_type::text IS DISTINCT FROM (CASE h.channel WHEN 'sms' THEN 'send_sms' ELSE 'send_email' END)
 OR a.payload->>'customer_id' IS DISTINCT FROM h.customer_id::text
 OR a.payload->>'conversation_interaction_id' IS DISTINCT FROM h.binding->>'latest'
 OR destination IS NULL
 OR destination IS DISTINCT FROM (CASE h.channel WHEN 'sms' THEN c.phone_canonical ELSE c.email_canonical END)
 OR destination IS DISTINCT FROM public.canonical_contact_destination(h.channel,CASE h.channel WHEN 'sms' THEN a.payload->>'to_phone' ELSE a.payload->>'to_email' END)
 THEN RAISE EXCEPTION 'Conversation binding changed; review required' USING ERRCODE='42501'; END IF;
 SELECT * INTO inbound FROM public.interactions WHERE shop_id=p_shop AND id=(h.binding->>'latest')::uuid AND customer_id=h.customer_id;
 IF inbound.id IS NULL OR inbound.channel::text IS DISTINCT FROM h.channel OR inbound.role::text IS DISTINCT FROM 'customer'
 OR inbound.metadata->>'direction' IS DISTINCT FROM 'inbound'
 OR (CASE h.channel WHEN 'sms' THEN inbound.metadata->>'from_phone' ELSE inbound.metadata->>'from_email' END) IS DISTINCT FROM destination
 OR inbound.created_at>clock_timestamp() OR inbound.created_at<clock_timestamp()-interval '48 hours'
 THEN RAISE EXCEPTION 'Recent inbound reply context unavailable' USING ERRCODE='42501'; END IF;
 IF h.channel='email' THEN
  SELECT * INTO evidence FROM public.email_reply_evidence WHERE shop_id=p_shop AND interaction_id=inbound.id;
  IF evidence.interaction_id IS NULL OR evidence.account_id IS DISTINCT FROM (SELECT aurinko_account_id FROM public.shops WHERE id=p_shop)
   OR evidence.binding IS DISTINCT FROM jsonb_build_object('customer',inbound.customer_id,'content',inbound.content,'created_at',inbound.created_at,'from',inbound.metadata->>'from_email')
  THEN RAISE EXCEPTION 'Verified mailbox reply evidence unavailable' USING ERRCODE='42501'; END IF;
  reply:=jsonb_build_object('account_id',evidence.account_id::text,'message_id',evidence.message_id,'thread_id',evidence.thread_id);
 END IF;
 RETURN jsonb_build_object('email_reply',reply,'interaction_id',inbound.id,'customer_id',h.customer_id,'channel',h.channel,'destination',destination,'content',inbound.content,'recorded_at',inbound.created_at);
END $$;
COMMIT;
