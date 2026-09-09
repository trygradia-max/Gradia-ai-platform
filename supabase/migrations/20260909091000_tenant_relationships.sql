-- Replace single-id public tenant relationships with tenant-bound FKs.
-- Preserve constraint names (PostgREST relation hints), NULLability and delete
-- actions. Any inconsistent existing row aborts; no data repair or reassignment.
DO $$
DECLARE r record; bad boolean; deletion text; updating text;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS child, c.confrelid::regclass AS parent,
           a.attname AS column_name, c.confdeltype, c.confupdtype, c.condeferrable, c.condeferred
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace AND n.nspname = 'public'
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1] AND pa.attname = 'id'
    WHERE c.contype = 'f' AND cardinality(c.conkey) = 1
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=c.conrelid AND attname='shop_id' AND NOT attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=c.confrelid AND attname='shop_id' AND NOT attisdropped)
    ORDER BY c.conrelid, c.conname
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s ch JOIN %s p ON p.id=ch.%I WHERE ch.shop_id IS DISTINCT FROM p.shop_id)', r.child, r.parent, r.column_name) INTO bad;
    IF bad THEN RAISE EXCEPTION 'Tenant relationship violation: %.%; migration aborted without repairing data', r.child, r.column_name; END IF;
    -- id is already globally unique, so this index cannot merge or discard rows.
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %s (shop_id, id)', replace(r.parent::text, '.', '_') || '_shop_id_id_unique', r.parent);
    deletion := CASE r.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN format('SET NULL (%I)',r.column_name) WHEN 'r' THEN 'RESTRICT' WHEN 'a' THEN 'NO ACTION' ELSE NULL END;
    updating := CASE r.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' ELSE NULL END;
    IF deletion IS NULL OR updating IS NULL THEN RAISE EXCEPTION 'Unsupported FK action: %; manual review required', r.conname; END IF;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I FOREIGN KEY (shop_id, %I) REFERENCES %s (shop_id, id) ON DELETE %s ON UPDATE %s %s',
      r.child, r.conname, r.conname, r.column_name, r.parent, deletion, updating,
      CASE WHEN r.condeferrable THEN CASE WHEN r.condeferred THEN 'DEFERRABLE INITIALLY DEFERRED' ELSE 'DEFERRABLE INITIALLY IMMEDIATE' END ELSE 'NOT DEFERRABLE' END);
  END LOOP;
END $$;

CREATE FUNCTION public.valid_job_photo_paths(paths text[], shop uuid, appointment uuid, phase text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM unnest(paths) path
    WHERE path IS NULL OR split_part(path, '/', 1) <> shop::text
      OR split_part(path, '/', 2) <> appointment::text
      OR array_length(string_to_array(path, '/'), 1) <> 3
      OR split_part(path, '/', 3) !~ ('^' || phase || '-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(jpg|jpeg|png|webp|heic|heif)$')
  );
$$;
ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_before_photo_scope CHECK (public.valid_job_photo_paths(photos_before, shop_id, id, 'before')),
  ADD CONSTRAINT appointments_after_photo_scope CHECK (public.valid_job_photo_paths(photos_after, shop_id, id, 'after'));
