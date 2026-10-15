-- Separate enum transaction: PostgreSQL requires new enum values to commit
-- before functions/commands can use them in the following migration.
ALTER TYPE public.pending_action_type ADD VALUE IF NOT EXISTS 'update_customer';
ALTER TYPE public.pending_action_type ADD VALUE IF NOT EXISTS 'resolve_customer';
ALTER TYPE public.pending_action_type ADD VALUE IF NOT EXISTS 'record_interaction';
