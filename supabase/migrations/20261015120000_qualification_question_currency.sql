BEGIN;
-- Send-time check for a queued qualification question. Read-only: it adds no
-- table, column, index, trigger, enum value or grant on any table.
--
-- A question queued by stage_qualification_question carries
-- payload.qualification = {workflow_id, revision, evidence_revision, target,
-- question_id}. The executor calls this before any transport, token refresh or
-- proof consumption. NULL means "not a qualification question, or still the
-- current one". Otherwise the result names why it must be held, with the same
-- rules staging used:
--   qualification_changed  the record or its evidence moved since queueing
--   review_required        identity or evidence now needs review
--   question_resolved      that is no longer the proposed question
-- See docs/architecture/LEAD_QUALIFICATION.md.
CREATE FUNCTION public.qualification_question_currency(p_shop uuid,p_action uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE binding jsonb; snap jsonb; expected_target text; expected_question uuid;
BEGIN
 -- The executor runs as the approving owner or delegated manager's session, or
 -- as the service role for delegated execution. Nobody else may probe records.
 IF coalesce(auth.role(),'')<>'service_role' AND public.lead_qualification_role(p_shop,false) IS NULL THEN
  RAISE EXCEPTION 'Qualification unavailable' USING ERRCODE='42501',DETAIL='forbidden'; END IF;
 SELECT a.payload->'qualification' INTO binding FROM public.pending_actions a
  WHERE a.id=p_action AND a.shop_id=p_shop AND a.action_type::text IN ('send_sms','send_email');
 IF binding IS NULL OR jsonb_typeof(binding)<>'object' THEN RETURN NULL; END IF;
 snap:=public.lead_qualification_snapshot(p_shop,(binding->>'workflow_id')::uuid);
 IF snap IS NULL THEN RETURN 'qualification_changed'; END IF;
 IF (snap->>'revision')::integer IS DISTINCT FROM (binding->>'revision')::integer
  OR (snap->'identity'->>'evidence_revision')::integer IS DISTINCT FROM (binding->>'evidence_revision')::integer THEN
  RETURN 'qualification_changed'; END IF;
 IF snap->'identity'->>'state'<>'identity_linked' OR snap->'identity'->>'customer_id' IS NULL OR snap->>'review_state'='needs_review'
  OR coalesce(jsonb_array_length(snap->'review_reasons'),0)>0 THEN
  RETURN 'review_required'; END IF;
 -- Same rule as staging and proposeNextQualificationQuestion: the first open
 -- question, else the first unknown field in the fixed order.
 SELECT (x->>'id')::uuid INTO expected_question FROM jsonb_array_elements(snap->'open_questions') WITH ORDINALITY q(x,n)
  WHERE x->>'status'='open' ORDER BY n LIMIT 1;
 IF expected_question IS NOT NULL THEN expected_target:='open_question';
 ELSE
  SELECT f INTO expected_target FROM unnest(ARRAY['service','vehicle_condition','timing','location','constraints']) WITH ORDINALITY u(f,n)
   WHERE snap->'fields'->f->>'status'='unknown' ORDER BY n LIMIT 1;
 END IF;
 IF expected_target IS DISTINCT FROM binding->>'target' OR expected_question IS DISTINCT FROM (binding->>'question_id')::uuid THEN
  RETURN 'question_resolved'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.qualification_question_currency(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.qualification_question_currency(uuid,uuid) TO authenticated,service_role;
COMMIT;
