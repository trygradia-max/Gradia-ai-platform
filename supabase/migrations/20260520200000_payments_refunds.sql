-- Track refunds against paid invoices so revenue tiles + BI chat stop
-- over-reporting. We only ever store the gross paid amount in
-- amount_cents; refunded_amount_cents is the total refunded so far
-- (Stripe's charge.refunded fires once per refund and `amount_refunded`
-- is cumulative, so upserts are idempotent). Net revenue =
-- amount_cents - refunded_amount_cents.
-- Idempotent.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refunded_amount_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_refunded_amount_nonneg'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_refunded_amount_nonneg
      CHECK (refunded_amount_cents >= 0 AND refunded_amount_cents <= amount_cents);
  END IF;
END $$;
