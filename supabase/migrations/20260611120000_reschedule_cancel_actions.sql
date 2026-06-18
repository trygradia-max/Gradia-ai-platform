-- Voice reschedule + cancel tools (work order item 2, 2026-06-11).
--
-- Two new pending_action types. Both are CALENDAR WRITES, so they join
-- book_appointment on the ALWAYS_HITL floor (locked principle #4): the
-- voice agent stages them; a human approves before the calendar moves.
-- Idempotent.

ALTER TYPE public.pending_action_type ADD VALUE IF NOT EXISTS 'reschedule_appointment';
ALTER TYPE public.pending_action_type ADD VALUE IF NOT EXISTS 'cancel_appointment';
