BEGIN;

-- Reviewed memory is a control-plane boundary, not another free-form RAG table.
-- Candidates are inert until an owner reviews and publishes an exact revision.
-- Retrieval joins the active pointer, so conflict/revocation takes effect at once.

CREATE TABLE public.reviewed_memory_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  source_name text NOT NULL CHECK (length(btrim(source_name)) BETWEEN 1 AND 120),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, id)
);

CREATE TABLE public.reviewed_memory_revisions (
  shop_id uuid NOT NULL,
  source_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (
    state IN ('candidate', 'reviewed', 'published', 'conflicted', 'revoked', 'deleted')
  ),
  raw_content text NOT NULL CHECK (length(btrim(raw_content)) BETWEEN 1 AND 80000),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  safety_status text NOT NULL CHECK (safety_status IN ('clean', 'flagged', 'blocked')),
  safety_flags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(safety_flags) = 'array'),
  author_id uuid NOT NULL REFERENCES auth.users(id),
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  published_by uuid REFERENCES auth.users(id),
  published_at timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  retention_until timestamptz,
  supersedes_revision integer,
  revoked_by uuid REFERENCES auth.users(id),
  revoked_at timestamptz,
  deleted_by uuid REFERENCES auth.users(id),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (shop_id, source_id, revision),
  FOREIGN KEY (shop_id, source_id)
    REFERENCES public.reviewed_memory_sources(shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, source_id, supersedes_revision)
    REFERENCES public.reviewed_memory_revisions(shop_id, source_id, revision),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  CHECK (retention_until IS NULL OR retention_until > created_at),
  CHECK (
    (state IN ('reviewed', 'published', 'revoked') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    OR state IN ('candidate', 'conflicted', 'deleted')
  ),
  CHECK (
    (state IN ('published', 'revoked') AND published_by IS NOT NULL AND published_at IS NOT NULL)
    OR state IN ('candidate', 'reviewed', 'conflicted', 'deleted')
  )
);

CREATE TABLE public.reviewed_memory_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  source_id uuid NOT NULL,
  revision integer NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 4000),
  embedding vector(1536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, source_id, revision, chunk_index),
  FOREIGN KEY (shop_id, source_id, revision)
    REFERENCES public.reviewed_memory_revisions(shop_id, source_id, revision)
    ON DELETE CASCADE
);

CREATE TABLE public.reviewed_memory_active (
  shop_id uuid NOT NULL,
  source_id uuid NOT NULL,
  revision integer NOT NULL,
  activated_by uuid NOT NULL REFERENCES auth.users(id),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (shop_id, source_id),
  FOREIGN KEY (shop_id, source_id, revision)
    REFERENCES public.reviewed_memory_revisions(shop_id, source_id, revision)
    ON DELETE CASCADE
);

CREATE TABLE public.reviewed_memory_heads (
  shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX reviewed_memory_revision_queue_idx
  ON public.reviewed_memory_revisions (shop_id, state, created_at DESC);
CREATE INDEX reviewed_memory_chunks_embedding_hnsw_idx
  ON public.reviewed_memory_chunks USING hnsw (embedding vector_cosine_ops);

ALTER TABLE public.reviewed_memory_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviewed_memory_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviewed_memory_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviewed_memory_active ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviewed_memory_heads ENABLE ROW LEVEL SECURITY;

CREATE POLICY reviewed_memory_sources_owner_read ON public.reviewed_memory_sources
  FOR SELECT TO authenticated USING (public.team_is_owner(shop_id));
CREATE POLICY reviewed_memory_revisions_owner_read ON public.reviewed_memory_revisions
  FOR SELECT TO authenticated USING (public.team_is_owner(shop_id));
CREATE POLICY reviewed_memory_chunks_owner_read ON public.reviewed_memory_chunks
  FOR SELECT TO authenticated USING (public.team_is_owner(shop_id));
CREATE POLICY reviewed_memory_active_owner_read ON public.reviewed_memory_active
  FOR SELECT TO authenticated USING (public.team_is_owner(shop_id));
CREATE POLICY reviewed_memory_heads_member_read ON public.reviewed_memory_heads
  FOR SELECT TO authenticated USING (public.team_is_owner(shop_id));

REVOKE ALL ON public.reviewed_memory_sources,
  public.reviewed_memory_revisions,
  public.reviewed_memory_chunks,
  public.reviewed_memory_active,
  public.reviewed_memory_heads
  FROM anon, authenticated;
GRANT SELECT ON public.reviewed_memory_sources,
  public.reviewed_memory_revisions,
  public.reviewed_memory_chunks,
  public.reviewed_memory_active,
  public.reviewed_memory_heads
  TO authenticated, service_role;

CREATE FUNCTION public.create_reviewed_memory_candidate(
  p_shop uuid,
  p_source_name text,
  p_content text,
  p_chunks jsonb,
  p_source uuid DEFAULT NULL,
  p_expected_revision integer DEFAULT NULL,
  p_valid_from timestamptz DEFAULT NULL,
  p_valid_until timestamptz DEFAULT NULL,
  p_retention_until timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source public.reviewed_memory_sources;
  next_revision integer;
  chunk jsonb;
  chunk_count integer;
  flags jsonb := '[]'::jsonb;
  safety text := 'clean';
  normalized text := lower(p_content);
BEGIN
  IF auth.uid() IS NULL OR NOT public.team_is_owner(p_shop) THEN
    RAISE EXCEPTION 'Owner review is required' USING ERRCODE = '42501';
  END IF;
  IF p_source_name IS NULL OR length(btrim(p_source_name)) NOT BETWEEN 1 AND 120
     OR p_content IS NULL OR length(btrim(p_content)) NOT BETWEEN 1 AND 80000
     OR p_chunks IS NULL OR jsonb_typeof(p_chunks) <> 'array'
     OR jsonb_array_length(p_chunks) NOT BETWEEN 1 AND 100
     OR (p_valid_until IS NOT NULL AND p_valid_from IS NOT NULL AND p_valid_until <= p_valid_from)
     OR (p_retention_until IS NOT NULL AND p_retention_until <= clock_timestamp()) THEN
    RAISE EXCEPTION 'Invalid memory candidate' USING ERRCODE = '22023';
  END IF;

  PERFORM id FROM public.shops WHERE id = p_shop FOR UPDATE;

  IF normalized ~ '(ignore|disregard|override).{0,40}(instruction|system|developer|policy)'
     OR normalized ~ '(system prompt|developer message|reveal.{0,20}(secret|credential|api key))' THEN
    safety := 'blocked';
    flags := flags || '["prompt_injection_pattern"]'::jsonb;
  END IF;
  IF p_content ~* '[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}' THEN
    flags := flags || '["possible_email_address"]'::jsonb;
    IF safety = 'clean' THEN safety := 'flagged'; END IF;
  END IF;
  IF p_content ~ '(\+?[0-9][0-9 ()\-]{7,}[0-9])' THEN
    flags := flags || '["possible_phone_number"]'::jsonb;
    IF safety = 'clean' THEN safety := 'flagged'; END IF;
  END IF;

  IF p_source IS NULL THEN
    INSERT INTO public.reviewed_memory_sources(shop_id, source_name, created_by)
    VALUES (p_shop, btrim(p_source_name), auth.uid()) RETURNING * INTO source;
    next_revision := 1;
  ELSE
    SELECT * INTO source FROM public.reviewed_memory_sources
    WHERE shop_id = p_shop AND id = p_source FOR UPDATE;
    IF source.id IS NULL THEN
      RAISE EXCEPTION 'Memory source not found' USING ERRCODE = 'P0002';
    END IF;
    SELECT max(revision) INTO next_revision
    FROM public.reviewed_memory_revisions
    WHERE shop_id = p_shop AND source_id = p_source;
    IF next_revision IS DISTINCT FROM p_expected_revision THEN
      RAISE EXCEPTION 'Memory revision changed; reload' USING ERRCODE = 'PT409';
    END IF;
    next_revision := next_revision + 1;
    UPDATE public.reviewed_memory_sources
      SET source_name = btrim(p_source_name), updated_at = clock_timestamp()
      WHERE shop_id = p_shop AND id = p_source;
  END IF;

  INSERT INTO public.reviewed_memory_revisions(
    shop_id, source_id, revision, state, raw_content, content_hash,
    safety_status, safety_flags, author_id, valid_from, valid_until,
    retention_until, supersedes_revision
  ) VALUES (
    p_shop, source.id, next_revision, 'candidate', btrim(p_content),
    encode(sha256(convert_to(btrim(p_content), 'UTF8')), 'hex'),
    safety, flags, auth.uid(), p_valid_from, p_valid_until,
    p_retention_until, p_expected_revision
  );

  chunk_count := 0;
  FOR chunk IN SELECT value FROM jsonb_array_elements(p_chunks)
  LOOP
    IF jsonb_typeof(chunk) <> 'object'
       OR length(btrim(chunk->>'content')) NOT BETWEEN 1 AND 4000
       OR (chunk ? 'embedding' AND chunk->'embedding' <> 'null'::jsonb
         AND (jsonb_typeof(chunk->'embedding') <> 'array'
           OR jsonb_array_length(chunk->'embedding') <> 1536)) THEN
      RAISE EXCEPTION 'Invalid memory chunk' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.reviewed_memory_chunks(
      shop_id, source_id, revision, chunk_index, content, embedding
    ) VALUES (
      p_shop, source.id, next_revision, chunk_count, btrim(chunk->>'content'),
      CASE WHEN NOT (chunk ? 'embedding') OR chunk->'embedding' = 'null'::jsonb
        THEN NULL
        ELSE ((chunk->'embedding')::text)::public.vector(1536)
      END
    );
    chunk_count := chunk_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'source_id', source.id,
    'revision', next_revision,
    'chunks', chunk_count,
    'state', 'candidate',
    'safety_status', safety,
    'safety_flags', flags
  );
END $$;

CREATE FUNCTION public.review_memory_revision(
  p_shop uuid,
  p_source uuid,
  p_revision integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  changed uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.team_is_owner(p_shop) THEN
    RAISE EXCEPTION 'Owner review is required' USING ERRCODE = '42501';
  END IF;
  PERFORM id FROM public.shops WHERE id = p_shop FOR UPDATE;
  UPDATE public.reviewed_memory_revisions
  SET state = 'reviewed', reviewed_by = auth.uid(), reviewed_at = clock_timestamp()
  WHERE shop_id = p_shop AND source_id = p_source AND revision = p_revision
    AND state = 'candidate' AND safety_status <> 'blocked'
  RETURNING source_id INTO changed;
  RETURN changed IS NOT NULL;
END $$;

CREATE FUNCTION public.publish_memory_revision(
  p_shop uuid,
  p_source uuid,
  p_revision integer,
  p_expected_active integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  candidate public.reviewed_memory_revisions;
  current_revision integer;
  conflict_source uuid;
  head_revision integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.team_is_owner(p_shop) THEN
    RAISE EXCEPTION 'Owner activation is required' USING ERRCODE = '42501';
  END IF;
  PERFORM id FROM public.shops WHERE id = p_shop FOR UPDATE;
  SELECT revision INTO current_revision FROM public.reviewed_memory_active
  WHERE shop_id = p_shop AND source_id = p_source FOR UPDATE;
  IF current_revision IS DISTINCT FROM p_expected_active THEN
    RAISE EXCEPTION 'Active memory changed; reload' USING ERRCODE = 'PT409';
  END IF;
  SELECT * INTO candidate FROM public.reviewed_memory_revisions
  WHERE shop_id = p_shop AND source_id = p_source AND revision = p_revision
  FOR UPDATE;
  IF candidate.source_id IS NULL OR candidate.state <> 'reviewed'
     OR candidate.safety_status = 'blocked' THEN
    RETURN jsonb_build_object('outcome', 'not_reviewed');
  END IF;

  SELECT a.source_id INTO conflict_source
  FROM public.reviewed_memory_active a
  JOIN public.reviewed_memory_sources active_source
    ON active_source.shop_id = a.shop_id AND active_source.id = a.source_id
  JOIN public.reviewed_memory_sources proposed_source
    ON proposed_source.shop_id = p_shop AND proposed_source.id = p_source
  JOIN public.reviewed_memory_revisions active_revision
    ON active_revision.shop_id = a.shop_id
   AND active_revision.source_id = a.source_id
   AND active_revision.revision = a.revision
  WHERE a.shop_id = p_shop AND a.source_id <> p_source
    AND lower(btrim(active_source.source_name)) = lower(btrim(proposed_source.source_name))
    AND active_revision.content_hash <> candidate.content_hash
  LIMIT 1;
  IF conflict_source IS NOT NULL THEN
    UPDATE public.reviewed_memory_revisions SET state = 'conflicted'
    WHERE shop_id = p_shop AND source_id = p_source AND revision = p_revision;
    RETURN jsonb_build_object('outcome', 'conflicted', 'conflict_source_id', conflict_source);
  END IF;

  IF current_revision IS NOT NULL THEN
    UPDATE public.reviewed_memory_revisions
    SET valid_until = coalesce(valid_until, clock_timestamp())
    WHERE shop_id = p_shop AND source_id = p_source AND revision = current_revision;
  END IF;
  UPDATE public.reviewed_memory_revisions
  SET state = 'published', published_by = auth.uid(), published_at = clock_timestamp(),
      valid_from = coalesce(valid_from, clock_timestamp()), valid_until = NULL
  WHERE shop_id = p_shop AND source_id = p_source AND revision = p_revision;
  INSERT INTO public.reviewed_memory_active(shop_id, source_id, revision, activated_by)
  VALUES (p_shop, p_source, p_revision, auth.uid())
  ON CONFLICT (shop_id, source_id) DO UPDATE
    SET revision = EXCLUDED.revision, activated_by = EXCLUDED.activated_by,
        activated_at = clock_timestamp();
  INSERT INTO public.reviewed_memory_heads(shop_id, revision)
  VALUES (p_shop, 1)
  ON CONFLICT (shop_id) DO UPDATE
    SET revision = public.reviewed_memory_heads.revision + 1,
        updated_at = clock_timestamp()
  RETURNING revision INTO head_revision;
  RETURN jsonb_build_object('outcome', 'published', 'knowledge_revision', head_revision);
END $$;

CREATE FUNCTION public.remove_memory_revision(
  p_shop uuid,
  p_source uuid,
  p_revision integer,
  p_expected_active integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_revision integer;
  current_state text;
  head_revision integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.team_is_owner(p_shop) THEN
    RAISE EXCEPTION 'Owner action is required' USING ERRCODE = '42501';
  END IF;
  PERFORM id FROM public.shops WHERE id = p_shop FOR UPDATE;
  SELECT state INTO current_state FROM public.reviewed_memory_revisions
  WHERE shop_id = p_shop AND source_id = p_source AND revision = p_revision FOR UPDATE;
  SELECT revision INTO current_revision FROM public.reviewed_memory_active
  WHERE shop_id = p_shop AND source_id = p_source FOR UPDATE;
  IF current_state IS NULL OR current_revision IS DISTINCT FROM p_expected_active THEN
    RAISE EXCEPTION 'Memory changed; reload' USING ERRCODE = 'PT409';
  END IF;
  IF current_revision = p_revision THEN
    DELETE FROM public.reviewed_memory_active
    WHERE shop_id = p_shop AND source_id = p_source;
    UPDATE public.reviewed_memory_revisions
    SET state = 'revoked', revoked_by = auth.uid(), revoked_at = clock_timestamp(),
        valid_until = coalesce(valid_until, clock_timestamp())
    WHERE shop_id = p_shop AND source_id = p_source AND revision = p_revision;
    INSERT INTO public.reviewed_memory_heads(shop_id, revision)
    VALUES (p_shop, 1)
    ON CONFLICT (shop_id) DO UPDATE
      SET revision = public.reviewed_memory_heads.revision + 1,
          updated_at = clock_timestamp()
    RETURNING revision INTO head_revision;
    RETURN jsonb_build_object('outcome', 'revoked', 'knowledge_revision', head_revision);
  END IF;
  UPDATE public.reviewed_memory_revisions
  SET state = 'deleted', deleted_by = auth.uid(), deleted_at = clock_timestamp()
  WHERE shop_id = p_shop AND source_id = p_source AND revision = p_revision
    AND state IN ('candidate', 'reviewed', 'conflicted');
  RETURN jsonb_build_object('outcome', 'deleted');
END $$;

CREATE VIEW public.published_shop_knowledge
WITH (security_invoker = true)
AS
SELECT c.id, c.shop_id, s.source_name, c.content,
  r.source_id, r.revision, r.content_hash, r.published_at,
  c.created_at, r.published_at AS updated_at
FROM public.reviewed_memory_active a
JOIN public.reviewed_memory_revisions r
  ON r.shop_id = a.shop_id AND r.source_id = a.source_id AND r.revision = a.revision
JOIN public.reviewed_memory_sources s
  ON s.shop_id = a.shop_id AND s.id = a.source_id
JOIN public.reviewed_memory_chunks c
  ON c.shop_id = a.shop_id AND c.source_id = a.source_id AND c.revision = a.revision
WHERE r.state = 'published'
  AND r.valid_from <= clock_timestamp()
  AND (r.valid_until IS NULL OR r.valid_until > clock_timestamp())
  AND (r.retention_until IS NULL OR r.retention_until > clock_timestamp());

GRANT SELECT ON public.published_shop_knowledge TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.match_shop_knowledge(
  p_shop_id uuid,
  p_query_embedding vector(1536),
  p_match_count int DEFAULT 4,
  p_min_similarity real DEFAULT 0.4
) RETURNS TABLE (id uuid, source_name text, content text, similarity real)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.id, s.source_name, c.content,
    (1 - (c.embedding OPERATOR(public.<=>) p_query_embedding))::real AS similarity
  FROM public.reviewed_memory_active a
  JOIN public.reviewed_memory_revisions r
    ON r.shop_id = a.shop_id AND r.source_id = a.source_id AND r.revision = a.revision
  JOIN public.reviewed_memory_sources s
    ON s.shop_id = a.shop_id AND s.id = a.source_id
  JOIN public.reviewed_memory_chunks c
    ON c.shop_id = a.shop_id AND c.source_id = a.source_id AND c.revision = a.revision
  WHERE a.shop_id = p_shop_id AND r.state = 'published'
    AND r.valid_from <= clock_timestamp()
    AND (r.valid_until IS NULL OR r.valid_until > clock_timestamp())
    AND (r.retention_until IS NULL OR r.retention_until > clock_timestamp())
    AND c.embedding IS NOT NULL
    AND (1 - (c.embedding OPERATOR(public.<=>) p_query_embedding)) >= p_min_similarity
  ORDER BY c.embedding OPERATOR(public.<=>) p_query_embedding ASC
  LIMIT greatest(1, least(p_match_count, 20));
$$;

CREATE FUNCTION public.match_reviewed_agent_memory(
  p_shop_id uuid,
  p_grants jsonb,
  p_query_embedding vector(1536),
  p_match_count int DEFAULT 4,
  p_min_similarity real DEFAULT 0.4
) RETURNS TABLE (
  id uuid,
  source_id uuid,
  source_revision integer,
  source_name text,
  content text,
  similarity real
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.id, c.source_id, c.revision, s.source_name, c.content,
    (1 - (c.embedding OPERATOR(public.<=>) p_query_embedding))::real AS similarity
  FROM jsonb_to_recordset(p_grants) AS grant_row(source_id uuid, revision integer)
  JOIN public.reviewed_memory_active a
    ON a.shop_id = p_shop_id AND a.source_id = grant_row.source_id
   AND a.revision = grant_row.revision
  JOIN public.reviewed_memory_revisions r
    ON r.shop_id = a.shop_id AND r.source_id = a.source_id AND r.revision = a.revision
  JOIN public.reviewed_memory_sources s
    ON s.shop_id = a.shop_id AND s.id = a.source_id
  JOIN public.reviewed_memory_chunks c
    ON c.shop_id = a.shop_id AND c.source_id = a.source_id AND c.revision = a.revision
  WHERE r.state = 'published' AND c.embedding IS NOT NULL
    AND r.valid_from <= clock_timestamp()
    AND (r.valid_until IS NULL OR r.valid_until > clock_timestamp())
    AND (r.retention_until IS NULL OR r.retention_until > clock_timestamp())
    AND (1 - (c.embedding OPERATOR(public.<=>) p_query_embedding)) >= p_min_similarity
  ORDER BY c.embedding OPERATOR(public.<=>) p_query_embedding ASC
  LIMIT greatest(1, least(p_match_count, 20));
$$;

CREATE FUNCTION public.reviewed_memory_stamp_run_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.knowledge_revision IS NULL THEN
    SELECT revision INTO NEW.knowledge_revision
    FROM public.reviewed_memory_heads WHERE shop_id = NEW.shop_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER custom_agent_runs_reviewed_memory_revision
BEFORE INSERT ON public.custom_agent_runs
FOR EACH ROW WHEN (NEW.trigger_source = 'schedule')
EXECUTE FUNCTION public.reviewed_memory_stamp_run_revision();

REVOKE ALL ON FUNCTION public.create_reviewed_memory_candidate(uuid, text, text, jsonb, uuid, integer, timestamptz, timestamptz, timestamptz),
  public.review_memory_revision(uuid, uuid, integer),
  public.publish_memory_revision(uuid, uuid, integer, integer),
  public.remove_memory_revision(uuid, uuid, integer, integer),
  public.match_reviewed_agent_memory(uuid, jsonb, vector, integer, real),
  public.reviewed_memory_stamp_run_revision()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.match_shop_knowledge(uuid, vector, integer, real)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_reviewed_memory_candidate(uuid, text, text, jsonb, uuid, integer, timestamptz, timestamptz, timestamptz),
  public.review_memory_revision(uuid, uuid, integer),
  public.publish_memory_revision(uuid, uuid, integer, integer),
  public.remove_memory_revision(uuid, uuid, integer, integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_shop_knowledge(uuid, vector, integer, real)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_reviewed_memory_candidate(uuid, text, text, jsonb, uuid, integer, timestamptz, timestamptz, timestamptz),
  public.review_memory_revision(uuid, uuid, integer),
  public.publish_memory_revision(uuid, uuid, integer, integer),
  public.remove_memory_revision(uuid, uuid, integer, integer),
  public.match_reviewed_agent_memory(uuid, jsonb, vector, integer, real)
  TO service_role;

-- Legacy rows are deliberately not grandfathered as reviewed. They remain for
-- audit/migration, but all retrieval now resolves through reviewed publication.
REVOKE INSERT, UPDATE, DELETE ON public.shop_knowledge FROM authenticated;

COMMIT;
