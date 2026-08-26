-- P0-009 — quote lifecycle truth. A quote whose booking durably landed
-- advances past 'accepted' to 'booked' (set by the approvals executor only
-- AFTER the serialized appointment write succeeds). Additive enum value,
-- idempotent, no data change; rollback leaves a harmless unused value.
ALTER TYPE public.quote_status ADD VALUE IF NOT EXISTS 'booked';
