# Runbook — Data Restore

_Created 2026-07-25 by the Organizer. Restores lean entirely on Supabase platform backups/PITR today — **whose tier, retention, and PITR granularity are REQUIRES VERIFICATION** (audit open question #17). Verify and record those facts in this file BEFORE the first incident needs them. The most dangerous data-loss shape is schema-level: the cascade chain `auth.users → shops → everything` hard-deletes financial ledgers, consent history, and memory with no soft delete anywhere (audit doc 05 weakness 2; risk R-10)._

## Trigger / symptoms
- Accidental deletion (customer file, shop, auth user — the cascade makes the last two catastrophic).
- Corruption from a bad manual fix, a botched import approval beyond undo's reach, or malicious writes via a leaked credential (`exposed-credential.md` feeds here).
- A merge gone wrong (customer merge is documented non-transactional).

## Severity
- Shop-level or ledger loss: **SEV-0/1** (financial + compliance history is legally meaningful — consent timestamps, A2P records).
- Single customer/record loss with recent backup: **SEV-2**.

## Before anything else
1. **Stop writes to the affected scope** if corruption is spreading: flag off the implicated feature (`emergency-feature-shutdown.md`) or, worst case, pause the whole app via Vercel. A restore into a moving target loses the race.
2. Record exact timestamps: last-known-good, first-bad-write. PITR precision is only as useful as this window.

## Restore paths (in preference order)
1. **Application-level reconstruction (least blast radius):** many objects are re-derivable — `payments` mirrors Stripe (re-sync from Stripe as source of truth); appointments mirror to Google Calendar (aurinko ids); CRM pushes mirror to Jobber/HCP. Rebuild the few rows from the external source rather than rewinding the DB.
2. **Supabase PITR / backup restore into a *separate* project** (never restore over live): extract only the affected shop's rows (every tenant table carries `shop_id` — scoping the extraction is straightforward), then re-insert into prod. Cross-tenant tables (`pricing_config`) rarely need this.
3. **Full project restore** — last resort; every other shop loses the delta since the restore point. SEV-0-only, founder decision, documented.

## Ledger discipline during restore
- `usage_events`, `payments`, `credit_grants` are append-only in principle (D-024). Restored ledger rows must reconcile against Stripe/Twilio/Vapi vendor records — the nightly reconciliation comparison is the checksum. Where the ledger can't be perfectly rebuilt, prefer a documented compensating grant over invented history.
- Never hand-craft `usage_events` rows to "make the balance right" — grants are the correction instrument.

## Verification
- Row counts + spot-checks per affected table against the external mirror (Stripe invoices, Google events, CRM records).
- Derived balance (`credits.ts`) sane; approvals badge, pipeline board, and customer files render for the affected shop.
- Embeddings: restored `interactions` may carry stale/absent vectors — semantic memory for the window may be degraded; note or re-embed (backfill path REQUIRES VERIFICATION, same as ai-provider-outage).

## Communication
- Owner gets: what was lost, what was rebuilt from which source, what is unrecoverable — specifically and honestly (D-028). If consent records were affected, treat marketing to those customers as un-consented until re-established (fail-closed posture).

## Postmortem
- Every firing of this runbook is evidence for E10 (soft delete + archival + de-fanging the auth.users cascade). Interim guard, effective immediately: **never delete an auth user or shop row as a "cleanup" action** — there is no undo; mark-and-disable instead.
- Update risk R-10.

## Known gaps (fill these in — they are the real runbook)
- [ ] Supabase plan tier / PITR availability / backup retention: **REQUIRES VERIFICATION — record here.**
- [ ] Tested restore-into-second-project drill: never performed. Schedule one before alpha exit; a restore procedure that has never run is a hypothesis, not a runbook.
- [ ] Storage buckets (`job-photos`, `recovery-imports`) backup posture: REQUIRES VERIFICATION (signed-URL bucket contents are not in DB backups).
- No soft delete / `deleted_at` anywhere until E10; undo exists only where explicitly built (approvals, recovery import).
