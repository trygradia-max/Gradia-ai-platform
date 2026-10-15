BEGIN;
-- Membership foundation. Existing owner RLS and credential-bearing shops remain private.
CREATE TABLE public.shop_memberships (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 display_name text NOT NULL DEFAULT 'Owner' CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
 role text NOT NULL CHECK (role IN ('owner','manager','staff')),
 active boolean NOT NULL DEFAULT true,
 revoked_at timestamptz,
 capabilities text[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (shop_id,user_id), UNIQUE (shop_id,id),
 CHECK (capabilities <@ ARRAY['crm.read','notes.write','jobs.progress','assignments.manage']::text[]),
 CHECK (role='manager' OR cardinality(capabilities)=0),
 CHECK (array_position(capabilities,NULL) IS NULL)
);
CREATE UNIQUE INDEX shop_one_owner ON public.shop_memberships(shop_id) WHERE role='owner';
CREATE TABLE public.shop_locations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 shop_id uuid NOT NULL UNIQUE REFERENCES public.shops(id) ON DELETE CASCADE,
 name text NOT NULL DEFAULT 'Primary location' CHECK (length(btrim(name)) BETWEEN 1 AND 120),
 UNIQUE (shop_id,id)
);
CREATE UNIQUE INDEX appointments_shop_id_id_unique ON public.appointments(shop_id,id);
CREATE TABLE public.shop_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 member_id uuid NOT NULL,
 customer_id uuid,
 appointment_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (num_nonnulls(customer_id,appointment_id)=1),
 FOREIGN KEY (shop_id,member_id) REFERENCES public.shop_memberships(shop_id,id) ON DELETE CASCADE,
 -- Refuse destructive customer deletion/merge until its assignments are explicitly removed.
 FOREIGN KEY (shop_id,customer_id) REFERENCES public.customers(shop_id,id),
 FOREIGN KEY (shop_id,appointment_id) REFERENCES public.appointments(shop_id,id) ON DELETE CASCADE,
 UNIQUE NULLS NOT DISTINCT (shop_id,member_id,customer_id,appointment_id)
);
CREATE TABLE public.shop_invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 email text NOT NULL CHECK (email=lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
 display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
 role text NOT NULL CHECK (role IN ('manager','staff')),
 capabilities text[] NOT NULL DEFAULT '{}',
 token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','cancelled')),
 created_by uuid NOT NULL,
 accepted_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (capabilities <@ ARRAY['crm.read','notes.write','jobs.progress','assignments.manage']::text[]),
 CHECK (role='manager' OR cardinality(capabilities)=0),
 CHECK (array_position(capabilities,NULL) IS NULL)
);
CREATE UNIQUE INDEX shop_pending_invitation ON public.shop_invitations(shop_id,email) WHERE status='pending';
-- action_decisions is tied to pending actions; authority changes need an independent,
-- transactional audit. No message/contact content or invitation bearer tokens here.
CREATE TABLE public.shop_team_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL,
 event text NOT NULL,
 subject_id uuid NOT NULL,
 details jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shop_team_audit_shop_created ON public.shop_team_audit(shop_id,created_at DESC);
ALTER TABLE public.shop_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_team_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shop_memberships,public.shop_locations,public.shop_assignments,public.shop_invitations,public.shop_team_audit FROM anon,authenticated;
GRANT SELECT ON public.shop_memberships,public.shop_locations,public.shop_assignments,public.shop_team_audit TO authenticated;
-- Invitation hashes/emails are never exposed through generic table SELECT.

CREATE FUNCTION public.team_is_owner(p_shop uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.shops WHERE id=p_shop AND owner_id=auth.uid());
$$;
CREATE FUNCTION public.team_has(p_shop uuid,p_cap text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.team_is_owner(p_shop) OR EXISTS(
 SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND active
 AND (p_cap='member' OR (role='manager' AND p_cap=ANY(capabilities))));
$$;
CREATE FUNCTION public.team_can_read(p_shop uuid,p_customer uuid DEFAULT NULL,p_appointment uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.team_has(p_shop,'crm.read') OR EXISTS(
 SELECT 1 FROM public.shop_memberships m JOIN public.shop_assignments a ON a.shop_id=m.shop_id AND a.member_id=m.id
 WHERE m.shop_id=p_shop AND m.user_id=auth.uid() AND m.active AND
 ((p_appointment IS NOT NULL AND a.appointment_id=p_appointment) OR
 (p_customer IS NOT NULL AND (a.customer_id=p_customer OR EXISTS(
 SELECT 1 FROM public.appointments j WHERE j.shop_id=p_shop AND j.id=a.appointment_id AND j.customer_id=p_customer)))));
$$;
CREATE POLICY team_members_read ON public.shop_memberships FOR SELECT TO authenticated
 USING (public.team_has(shop_id,'assignments.manage') OR user_id=auth.uid() AND active);
CREATE POLICY team_location_read ON public.shop_locations FOR SELECT TO authenticated USING (public.team_has(shop_id,'member'));
CREATE POLICY team_assignment_read ON public.shop_assignments FOR SELECT TO authenticated
 USING (public.team_has(shop_id,'assignments.manage') OR member_id IN (SELECT id FROM public.shop_memberships WHERE user_id=auth.uid() AND active));
CREATE POLICY team_audit_read ON public.shop_team_audit FOR SELECT TO authenticated USING (public.team_is_owner(shop_id));
-- Add SELECT only. Legacy owner-only mutation policies remain unchanged.
CREATE POLICY team_customer_read ON public.customers FOR SELECT TO authenticated USING (public.team_can_read(shop_id,id));
CREATE POLICY team_appointment_read ON public.appointments FOR SELECT TO authenticated USING (public.team_can_read(shop_id,NULL,id));
CREATE POLICY team_vehicle_read ON public.vehicles FOR SELECT TO authenticated USING (public.team_can_read(shop_id,customer_id));
CREATE POLICY team_note_read ON public.interactions FOR SELECT TO authenticated USING (customer_id IS NOT NULL AND public.team_can_read(shop_id,customer_id));

CREATE FUNCTION public.team_owner_invariant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE owner_user uuid;
BEGIN
 SELECT owner_id INTO owner_user FROM public.shops WHERE id=NEW.shop_id;
 IF (NEW.role='owner' AND (NEW.user_id IS DISTINCT FROM owner_user OR NOT NEW.active)) OR
    (NEW.user_id=owner_user AND NEW.role<>'owner') THEN
  RAISE EXCEPTION 'Owner membership must match the shop owner and remain active' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shop_member_owner_invariant BEFORE INSERT OR UPDATE ON public.shop_memberships FOR EACH ROW EXECUTE FUNCTION public.team_owner_invariant();

CREATE FUNCTION public.team_bootstrap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
   RAISE EXCEPTION 'Owner transfer requires a separately reviewed workflow' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
 END IF;
 INSERT INTO public.shop_memberships(shop_id,user_id,role) VALUES(NEW.id,NEW.owner_id,'owner');
 INSERT INTO public.shop_locations(shop_id) VALUES(NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER shop_team_bootstrap AFTER INSERT OR UPDATE OF owner_id ON public.shops FOR EACH ROW EXECUTE FUNCTION public.team_bootstrap();
INSERT INTO public.shop_memberships(shop_id,user_id,role) SELECT id,owner_id,'owner' FROM public.shops;
INSERT INTO public.shop_locations(shop_id) SELECT id FROM public.shops;

-- All mutations take the same shop lock before checking current membership. A
-- concurrent revocation and write serialize, rather than authorize on stale grants.
CREATE FUNCTION public.team_lock(p_shop uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
 IF NOT public.team_has(p_shop,'member') THEN RAISE EXCEPTION 'Active shop access required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 IF NOT public.team_has(p_shop,'member') THEN RAISE EXCEPTION 'Active shop access required' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION public.team_workspaces() RETURNS TABLE(id uuid,name text,role text,capabilities text[],location_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT s.id,s.name,m.role,m.capabilities,l.id FROM public.shops s
 JOIN public.shop_memberships m ON m.shop_id=s.id AND m.user_id=auth.uid() AND m.active
 JOIN public.shop_locations l ON l.shop_id=s.id ORDER BY s.created_at;
$$;
CREATE FUNCTION public.team_set_member(p_shop uuid,p_member uuid,p_role text,p_active boolean,p_capabilities text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_member public.shop_memberships;
BEGIN
 PERFORM public.team_lock(p_shop);
 IF NOT public.team_is_owner(p_shop) THEN RAISE EXCEPTION 'Only the owner can manage memberships' USING ERRCODE='42501'; END IF;
 SELECT * INTO old_member FROM public.shop_memberships WHERE shop_id=p_shop AND id=p_member FOR UPDATE;
 IF NOT FOUND OR old_member.role='owner' OR p_role NOT IN ('manager','staff') OR p_active IS NULL THEN
  RAISE EXCEPTION 'Choose a non-owner membership'; END IF;
 UPDATE public.shop_memberships SET role=p_role,active=p_active,capabilities=p_capabilities,revoked_at=CASE WHEN NOT p_active THEN clock_timestamp() ELSE revoked_at END WHERE id=p_member;
 -- Revocation/role reduction removes stale assignments; reactivation requires explicit assignment.
 IF NOT p_active THEN
  UPDATE public.shop_invitations SET status='cancelled' WHERE shop_id=p_shop AND status='pending' AND email=(SELECT lower(btrim(email)) FROM auth.users WHERE id=old_member.user_id);
 END IF;
 IF NOT p_active OR old_member.role<>p_role THEN DELETE FROM public.shop_assignments WHERE shop_id=p_shop AND member_id=p_member; END IF;
 INSERT INTO public.shop_team_audit(shop_id,actor_id,event,subject_id,details) VALUES
 (p_shop,auth.uid(),'membership_changed',p_member,jsonb_build_object('before_role',old_member.role,'role',p_role,'active',p_active,'capabilities',p_capabilities));
END $$;
CREATE FUNCTION public.team_invite(p_shop uuid,p_email text,p_role text,p_capabilities text[],p_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE token text; invitation uuid;
BEGIN
 PERFORM public.team_lock(p_shop);
 IF NOT public.team_is_owner(p_shop) THEN RAISE EXCEPTION 'Only the owner can invite' USING ERRCODE='42501'; END IF;
 IF p_email IS NULL OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN RAISE EXCEPTION 'Enter a valid email'; END IF;
 token:=encode(extensions.gen_random_bytes(32),'hex');
 -- Reissue explicitly invalidates every earlier pending invitation for this address.
 UPDATE public.shop_invitations SET status='cancelled' WHERE shop_id=p_shop AND email=lower(btrim(p_email)) AND status='pending';
 INSERT INTO public.shop_invitations(shop_id,email,role,capabilities,token_hash,expires_at,created_by,display_name)
 VALUES(p_shop,lower(btrim(p_email)),p_role,p_capabilities,encode(extensions.digest(token,'sha256'),'hex'),now()+interval '7 days',auth.uid(),btrim(p_name)) RETURNING id INTO invitation;
 INSERT INTO public.shop_team_audit(shop_id,actor_id,event,subject_id,details) VALUES(p_shop,auth.uid(),'invitation_created',invitation,jsonb_build_object('role',p_role,'capabilities',p_capabilities));
 RETURN jsonb_build_object('id',invitation,'token',token);
END $$;
CREATE FUNCTION public.team_cancel_invite(p_shop uuid,p_invitation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.team_lock(p_shop);
 IF NOT public.team_is_owner(p_shop) THEN RAISE EXCEPTION 'Only the owner can cancel invitations' USING ERRCODE='42501'; END IF;
 UPDATE public.shop_invitations SET status='cancelled' WHERE shop_id=p_shop AND id=p_invitation AND status='pending';
 IF NOT FOUND THEN RAISE EXCEPTION 'Invitation is no longer pending'; END IF;
 INSERT INTO public.shop_team_audit(shop_id,actor_id,event,subject_id) VALUES(p_shop,auth.uid(),'invitation_cancelled',p_invitation);
END $$;
CREATE FUNCTION public.team_list_invites(p_shop uuid) RETURNS TABLE(id uuid,email text,role text,status text,expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT i.id,i.email,i.role,i.status,i.expires_at FROM public.shop_invitations i
 WHERE i.shop_id=p_shop AND public.team_is_owner(p_shop) ORDER BY i.created_at DESC LIMIT 100;
$$;
CREATE FUNCTION public.team_accept_invite(p_token text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE invitation public.shop_invitations; member uuid; verified_email text;
BEGIN
 IF auth.uid() IS NULL OR p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO invitation FROM public.shop_invitations WHERE token_hash=encode(extensions.digest(p_token,'sha256'),'hex');
 IF NOT FOUND THEN RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='42501'; END IF;
 -- Same lock order as revocation/reissue; re-read invitation AFTER waiting.
 PERFORM 1 FROM public.shops WHERE id=invitation.shop_id FOR UPDATE;
 SELECT * INTO invitation FROM public.shop_invitations WHERE id=invitation.id FOR UPDATE;
 SELECT lower(btrim(email)) INTO verified_email FROM auth.users WHERE id=auth.uid() AND email_confirmed_at IS NOT NULL;
 IF invitation.status<>'pending' OR invitation.expires_at<=clock_timestamp() OR invitation.email IS DISTINCT FROM verified_email THEN
  RAISE EXCEPTION 'Invitation unavailable or not for this verified account' USING ERRCODE='42501'; END IF;
 -- Revocation is identity-bound even if the user's email changed. No older
 -- invitation can reactivate this identity; the owner must issue a new grant.
 IF EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=invitation.shop_id AND user_id=auth.uid() AND revoked_at>=invitation.created_at) THEN
  RAISE EXCEPTION 'Invitation predates membership revocation' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=invitation.shop_id AND user_id=auth.uid() AND active) THEN
  RAISE EXCEPTION 'Already an active member'; END IF;
 INSERT INTO public.shop_memberships(shop_id,user_id,role,capabilities,display_name) VALUES(invitation.shop_id,auth.uid(),invitation.role,invitation.capabilities,invitation.display_name)
 ON CONFLICT(shop_id,user_id) DO UPDATE SET role=EXCLUDED.role,capabilities=EXCLUDED.capabilities,display_name=EXCLUDED.display_name,active=true RETURNING id INTO member;
 UPDATE public.shop_invitations SET status='accepted',accepted_by=auth.uid() WHERE id=invitation.id;
 INSERT INTO public.shop_team_audit(shop_id,actor_id,event,subject_id,details) VALUES(invitation.shop_id,auth.uid(),'invitation_accepted',member,jsonb_build_object('invitation_id',invitation.id));
 RETURN invitation.shop_id;
END $$;
CREATE FUNCTION public.team_assign(p_shop uuid,p_member uuid,p_customer uuid DEFAULT NULL,p_appointment uuid DEFAULT NULL,p_remove boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target public.shop_memberships;
BEGIN
 PERFORM public.team_lock(p_shop);
 IF NOT public.team_has(p_shop,'assignments.manage') THEN RAISE EXCEPTION 'Assignment permission required' USING ERRCODE='42501'; END IF;
 IF num_nonnulls(p_customer,p_appointment)<>1 THEN RAISE EXCEPTION 'Choose one customer or job'; END IF;
 SELECT * INTO target FROM public.shop_memberships WHERE shop_id=p_shop AND id=p_member AND active;
 IF NOT FOUND THEN RAISE EXCEPTION 'Active member not found'; END IF;
 -- Managers can assign staff, never themselves, other managers or the owner.
 IF NOT public.team_is_owner(p_shop) AND target.role<>'staff' THEN RAISE EXCEPTION 'Managers may assign staff only' USING ERRCODE='42501'; END IF;
 IF NOT public.team_can_read(p_shop,p_customer,p_appointment) THEN RAISE EXCEPTION 'Record access required' USING ERRCODE='42501'; END IF;
 IF (p_customer IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.customers WHERE shop_id=p_shop AND id=p_customer)) OR (p_appointment IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.appointments WHERE shop_id=p_shop AND id=p_appointment)) THEN RAISE EXCEPTION 'Record not found'; END IF;
 IF p_remove THEN
  DELETE FROM public.shop_assignments WHERE shop_id=p_shop AND member_id=p_member AND customer_id IS NOT DISTINCT FROM p_customer AND appointment_id IS NOT DISTINCT FROM p_appointment;
 ELSE
  INSERT INTO public.shop_assignments(shop_id,member_id,customer_id,appointment_id) VALUES(p_shop,p_member,p_customer,p_appointment) ON CONFLICT DO NOTHING;
 END IF;
 INSERT INTO public.shop_team_audit(shop_id,actor_id,event,subject_id,details) VALUES(p_shop,auth.uid(),CASE WHEN p_remove THEN 'assignment_removed' ELSE 'assignment_added' END,p_member,jsonb_build_object('customer_id',p_customer,'appointment_id',p_appointment));
END $$;
CREATE FUNCTION public.team_add_note(p_shop uuid,p_customer uuid,p_content text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result uuid;
BEGIN
 PERFORM public.team_lock(p_shop);
 IF NOT public.team_can_read(p_shop,p_customer) OR NOT (public.team_has(p_shop,'notes.write') OR EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND active AND role='staff')) THEN
  RAISE EXCEPTION 'Note permission required' USING ERRCODE='42501'; END IF;
 IF p_content IS NULL OR length(btrim(p_content)) NOT BETWEEN 1 AND 4000 OR NOT EXISTS(SELECT 1 FROM public.customers WHERE shop_id=p_shop AND id=p_customer) THEN RAISE EXCEPTION 'Valid customer and note required'; END IF;
 INSERT INTO public.interactions(shop_id,customer_id,channel,role,content,metadata) VALUES(p_shop,p_customer,'note','system',btrim(p_content),jsonb_build_object('source','team','actor_id',auth.uid())) RETURNING id INTO result;
 INSERT INTO public.shop_team_audit(shop_id,actor_id,event,subject_id,details) VALUES(p_shop,auth.uid(),'note_added',result,jsonb_build_object('customer_id',p_customer));
 RETURN result;
END $$;
CREATE FUNCTION public.team_job_progress(p_shop uuid,p_appointment uuid,p_expected text,p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE previous text;
BEGIN
 PERFORM public.team_lock(p_shop);
 IF NOT public.team_can_read(p_shop,NULL,p_appointment) OR NOT (public.team_has(p_shop,'jobs.progress') OR EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=auth.uid() AND active AND role='staff')) THEN
  RAISE EXCEPTION 'Job progress permission required' USING ERRCODE='42501'; END IF;
 SELECT status::text INTO previous FROM public.appointments WHERE shop_id=p_shop AND id=p_appointment FOR UPDATE;
 IF NOT FOUND OR previous IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Job changed; refresh before updating'; END IF;
 IF NOT ((previous IN ('booked','confirmed') AND p_status='checked_in') OR (previous IN ('checked_in','on_hold') AND p_status='in_progress') OR (previous='in_progress' AND p_status IN ('on_hold','completed'))) THEN
  RAISE EXCEPTION 'This progress transition is not permitted'; END IF;
 UPDATE public.appointments SET status=p_status::public.job_status,updated_at=now() WHERE shop_id=p_shop AND id=p_appointment;
 INSERT INTO public.shop_team_audit(shop_id,actor_id,event,subject_id,details) VALUES(p_shop,auth.uid(),'job_progress',p_appointment,jsonb_build_object('before',previous,'after',p_status));
END $$;
-- Explicit ACLs: no PUBLIC/anon RPC execution or direct table mutation.
REVOKE ALL ON FUNCTION public.team_is_owner(uuid),public.team_has(uuid,text),public.team_can_read(uuid,uuid,uuid),public.team_owner_invariant(),public.team_bootstrap(),public.team_lock(uuid),public.team_workspaces(),public.team_set_member(uuid,uuid,text,boolean,text[]),public.team_invite(uuid,text,text,text[],text),public.team_cancel_invite(uuid,uuid),public.team_list_invites(uuid),public.team_accept_invite(text),public.team_assign(uuid,uuid,uuid,uuid,boolean),public.team_add_note(uuid,uuid,text),public.team_job_progress(uuid,uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.team_is_owner(uuid),public.team_has(uuid,text),public.team_can_read(uuid,uuid,uuid),public.team_workspaces(),public.team_set_member(uuid,uuid,text,boolean,text[]),public.team_invite(uuid,text,text,text[],text),public.team_cancel_invite(uuid,uuid),public.team_list_invites(uuid),public.team_accept_invite(text),public.team_assign(uuid,uuid,uuid,uuid,boolean),public.team_add_note(uuid,uuid,text),public.team_job_progress(uuid,uuid,text,text) TO authenticated;
COMMIT;
