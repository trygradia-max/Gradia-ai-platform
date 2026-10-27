BEGIN;
-- One number purchase at a time per business (number-lifecycle audit, after
-- review finding R8). Twilio charges a number's first month when it is
-- bought, so two purchases racing each other cost an extra month even when the
-- loser releases its duplicate straight away. purchaseNumber and the BYO
-- provision path take this claim (a compare-and-swap on these columns) before
-- any provider call, and clear it when they finish. A claim older than the
-- app's TTL (2 minutes, longer than the server action can run) is stale and
-- may be taken over, so a crashed purchase never blocks the business.
--
-- Additive and nullable: existing rows are unchanged (no claim). Only trusted
-- server code (service role) writes them; an owner setting them could only
-- delay their own purchase by the TTL.
ALTER TABLE public.shops
 ADD COLUMN number_purchase_claim uuid,
 ADD COLUMN number_purchase_claimed_at timestamptz;
COMMIT;
