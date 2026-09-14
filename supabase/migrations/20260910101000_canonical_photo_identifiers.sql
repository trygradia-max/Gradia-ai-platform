BEGIN;
CREATE OR REPLACE FUNCTION public.valid_job_photo_paths(paths text[], shop uuid, appointment uuid, phase text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT phase IN ('before','after') AND shop IS NOT NULL AND appointment IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM unnest(paths) path
    WHERE path IS NULL OR split_part(path, '/', 1) <> shop::text
      OR split_part(path, '/', 2) <> appointment::text
      OR array_length(string_to_array(path, '/'), 1) <> 3
      OR split_part(split_part(path, '/', 3), '-', 1) <> phase
      OR split_part(path, '/', 3) !~ ('^(before|after)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)$')
  );
$$;
-- Refuse pre-existing inconsistent paths; never repair or normalize stored values.
ALTER TABLE public.appointments DROP CONSTRAINT appointments_before_photo_scope, DROP CONSTRAINT appointments_after_photo_scope;
ALTER TABLE public.appointments
 ADD CONSTRAINT appointments_before_photo_scope CHECK(public.valid_job_photo_paths(photos_before,shop_id,id,'before')),
 ADD CONSTRAINT appointments_after_photo_scope CHECK(public.valid_job_photo_paths(photos_after,shop_id,id,'after'));
COMMIT;
