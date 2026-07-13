-- C7 structured-CSV import wizard (GRADIA_CRM_FOUNDATION_SPEC §C7):
-- a new SOURCE TYPE on the existing P8 import pipeline — same import_jobs /
-- import_messages staging, same review queue, same provenance/undo.
--
-- Applied by the founder (overnight run 2026-07-08 rail). Code tolerates this
-- being unapplied: starting a structured_csv import surfaces a clear error
-- instead of writing anything.

ALTER TYPE public.import_source_type ADD VALUE IF NOT EXISTS 'structured_csv';
