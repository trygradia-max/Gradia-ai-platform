BEGIN;
-- Agent captures propose work; a chat/tool call is never a human approval.
-- Reuse the policy staging trigger and the existing approval executor.
CREATE FUNCTION public.stage_agent_capture(
 p_shop uuid, p_actor uuid, p_command uuid, p_type text, p_payload jsonb,
 p_source text, p_token uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE existing public.pending_actions; bound jsonb;
BEGIN
 -- Same serialization lock as membership/policy changes; service callers have
 -- no auth.uid(), so perform the explicit actor/token checks below.
 PERFORM 1 FROM public.shops WHERE id=p_shop FOR UPDATE;
 IF p_source IS NULL OR p_source NOT IN ('owner_agent','mcp') OR p_type IS NULL
 OR p_type NOT IN ('add_note','create_lead') OR p_command IS NULL
 OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN
  RAISE EXCEPTION 'Invalid capture command' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.shops s JOIN public.shop_memberships m ON m.shop_id=s.id
  WHERE s.id=p_shop AND s.owner_id=p_actor AND m.user_id=p_actor AND m.active AND m.role='owner' AND NOT coalesce(s.simulation_mode,false))
 OR (auth.role() IS DISTINCT FROM 'service_role' AND (auth.uid() IS DISTINCT FROM p_actor OR p_source<>'owner_agent')) THEN
  RAISE EXCEPTION 'Capture actor unavailable' USING ERRCODE='42501';
 END IF;
 IF p_source='mcp' THEN
  IF p_token IS NULL OR NOT EXISTS(SELECT 1 FROM public.mcp_tokens WHERE id=p_token AND shop_id=p_shop AND revoked_at IS NULL FOR SHARE) THEN
   RAISE EXCEPTION 'Capture token unavailable' USING ERRCODE='42501';
  END IF;
 ELSIF p_token IS NOT NULL THEN RAISE EXCEPTION 'Unexpected token' USING ERRCODE='22023'; END IF;
 -- Bind attribution in trusted code, never use the model-supplied source label.
 bound:=p_payload || jsonb_build_object('source',p_source,'mcp_token_id',p_token);
 SELECT * INTO existing FROM public.pending_actions WHERE id=p_command;
 IF existing.id IS NOT NULL THEN
  IF existing.shop_id<>p_shop OR existing.requested_by IS DISTINCT FROM p_actor
   OR existing.action_type::text<>p_type OR existing.payload IS DISTINCT FROM bound THEN
   RAISE EXCEPTION 'Command identity conflict' USING ERRCODE='PT409';
  END IF;
  RETURN existing.id;
 END IF;
 INSERT INTO public.pending_actions(id,shop_id,requested_by,action_type,payload)
 VALUES(p_command,p_shop,p_actor,p_type::public.pending_action_type,bound);
 RETURN p_command;
END $$;
REVOKE ALL ON FUNCTION public.stage_agent_capture(uuid,uuid,uuid,text,jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.stage_agent_capture(uuid,uuid,uuid,text,jsonb,text,uuid) TO authenticated,service_role;
COMMIT;
