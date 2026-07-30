# Runbook — Failed Migration

_Created 2026-07-25 by the Organizer. Gradia's migration posture: 55 idempotent, additive, well-commented SQL files (audit doc 05); policy is **additive-only** (GO_LIVE_CHECKLIST §7: code rollback never requires DB rollback). The sharp edge is the inverse failure: **"pre-C1 tolerance" means the app runs silently degraded against a DB missing expected schema** — dozens of `console.warn`-and-continue paths make a half-migrated database look like a working product with quotes/vehicles/stages mysteriously absent (audit docs 08/09; open question #16: nothing in-repo proves prod schema state)._

## Trigger / symptoms
- A migration errors mid-apply against prod.
- Deploy went out but its migration didn't (or vice versa): features silently missing, `console.warn` "pre-C1" noise in Vercel logs, friendly "not available yet" errors in quote/vehicle paths.
- Integration test tier disagrees with prod behavior (once un-quarantined by P0-002, it validates migrations in CI — today it validates nothing).

## Severity
- Migration failed partway leaving inconsistent schema: **SEV-1** until assessed.
- Migration simply not applied (app degrades silently): **SEV-2** — unless money/booking paths are affected, then SEV-1.

## Immediate containment
1. **Don't roll code back reflexively.** Additive migrations mean old code runs fine against new schema; the reverse (new code, old schema) is the degraded-but-running state — tolerable briefly, not silently.
2. Stop further deploys until schema state is known.
3. If the failure is a partially-applied file: because files are written idempotently (`IF NOT EXISTS`, `ON CONFLICT`), **re-running the same migration is the designed recovery** — verify the error cause first (lock timeout vs genuine conflict vs privilege issue, e.g. `storage.buckets` writes needing manual creation per GO_LIVE_CHECKLIST §1).

## Diagnosis
- Establish actual prod schema state explicitly — never infer from app behavior (that's what the tolerance pattern hides). Compare `supabase/migrations/` filenames against the applied-migrations table / Supabase dashboard.
- Spot-check the specific objects the failed file creates (the GO_LIVE_CHECKLIST §1 pattern: named columns/tables/buckets).
- Check for the known non-SQL step: storage bucket creation may need the dashboard if the runner can't write `storage.buckets`.

## Recovery
- Fix the failing statement (or apply the manual step), re-run the idempotent file to completion, then re-verify object-by-object.
- If schema is correct but the app still warns: the drift may be in hand-written types (`database.ts` — no codegen; audit doc 05) rather than the DB. That's a code fix, not a DB fix.
- Never "fix forward" by editing an already-applied migration file — add a new numbered migration (existing convention).

## Verification
- Object spot-checks pass; the feature that motivated the migration works on a test shop; no "pre-C1"-style warns for the affected area in logs.
- Integration tier green against a fresh DB built from the full migration chain (this is the standing proof the chain replays — protect it via P0-002).

## Communication
- Usually internal; owner-facing only if a feature was visibly degraded — then honest per D-028.

## Postmortem
- If prod ran degraded silently for any period: that is the tolerance-pattern cost realized — feed it to the "structured failure info / no silent failure paths" standard (`08-security-and-reliability.md`) and P0-012 alerting.
- If the migration itself was flawed: why didn't the integration tier catch it (quarantined? missing test?) — P0-002 scope.

## Known gaps
- No automated prod-schema attestation; verification is manual dashboard work (open question #16).
- Migration validation only lives in the quarantined integration tier until P0-002.
- No `updated_at` triggers, hand-written types — schema/type drift is unpoliced (E03 codegen item).
- Destructive migrations (if E03's single-truth pass ever drops legacy columns) will need a stronger version of this runbook: backup checkpoint + staged rollout — write that section before the first non-additive file ships.
