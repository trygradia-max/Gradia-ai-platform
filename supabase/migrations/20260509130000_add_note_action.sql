-- Whisper introduces a second pending_action_type: notes the detailer
-- speaks while on a job. On approval, the note is written to the
-- interactions table (channel='note') so it lives in the same shared
-- memory layer the rest of Gradia reads from.
--
-- ALTER TYPE ... ADD VALUE supports IF NOT EXISTS in Postgres 12+, so
-- this migration is replayable.

ALTER TYPE public.pending_action_type ADD VALUE IF NOT EXISTS 'add_note';
