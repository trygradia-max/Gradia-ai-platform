# Runbook — Broken Import

_Created 2026-07-25 by the Organizer. Imports are a first-run trust moment (D-006: real CRM/calendar data arrives during trial) and carry a decided standard (D-022): **staging → mapping → preview → validation → error reporting → rollback**. The existing recovery pipeline is the reference implementation: `import_jobs`/`import_messages` staging, LLM extraction, dedupe, review queue, approve-with-undo, retention purge of raw bodies (`recovery-imports` bucket), TCPA gating. This runbook covers imports that corrupt, duplicate, stall, or leak._

## Trigger / symptoms
- Import stuck mid-state (`import_jobs` status not advancing); owner reports wrong/duplicated customers after approval; extraction produced garbage candidates; credits burned with no output.
- Raw uploaded bodies still present past retention expectations.
- Wrong-tenant symptoms during import → switch immediately to `tenant-data-leak.md` (import routes run service-role with resolved shop).

## Severity
- Corrupted/duplicated customer data **approved into a live shop's CRM**: **SEV-1** (the owner's real business records).
- Stalled or failed import still in staging: **SEV-2/3** — staging exists precisely so failure here is cheap.
- Raw import PII retained/exposed beyond policy: **SEV-1**.

## Immediate containment
1. **Stop at the staging boundary:** if candidates are bad, simply don't approve — nothing has touched the live CRM. Tell the owner to pause review.
2. If the import feature itself is misbehaving across shops: flip `FEATURES.customerRecovery` (or the structured-import flag) off + redeploy — the routes 404 (the GO_LIVE_CHECKLIST treats this flag as the gate).
3. If bad rows were **already approved**: use the built undo on the approval batch first; only if undo is insufficient, plan manual correction (merge tooling exists for dupes — note the merge is documented non-transactional, do it deliberately).
4. PII overhang: run `/api/cron/recovery-retention` (with `CRON_SECRET`) to purge raw bodies, or empty the `recovery-imports` bucket manually (GO_LIVE_CHECKLIST §7 note).

## Diagnosis
- `import_jobs` / `import_messages` state machine: where did it stall (parse, estimate, extraction, review, approve)? Extraction is LLM-backed — an Anthropic failure here presents as a stalled/empty import (`ai-provider-outage.md` may be the real incident).
- Dedupe misfires: the three conservative layers vs the known normalization edge — **phone identity assumes E.164; unnormalized numbers create duplicate identities** (audit doc 05 weakness 12). Check the source file's phone formats.
- Credits: import metering is fail-closed with pre-estimates ("~N credits") — if burn happened with no output, reconcile per `double-billing.md` (compensating grant).

## Recovery
- Fix or re-map, then **re-run from staging** — approved-with-undo plus staged design means the safe path is: undo → correct → re-import → re-review. Never hand-edit half an import in place.
- For partial approvals: identify approved candidates via the import job's linkage (`vehicles.import_job_id` SET NULL FK pattern, timeline notes with `source=import`) to scope precisely what entered the CRM.
- Refund import credits if the pipeline (not the data) was at fault.

## Verification
- Re-imported set matches source counts minus documented skips; dedupe review queue empty of false merges; spot-check 5 customers against the source file.
- Retention: raw bodies purged post-extraction; bucket checked.
- TCPA/consent posture intact: imported customers with >18-month last-transaction are not SMS-targetable; `do_not_contact` respected (these are locked behaviors — verify, don't assume, after any manual correction).

## Communication
- The owner sees an **error report, not a shrug** (D-022): what failed, which rows, what to fix in their export, what was rolled back. During trial this is a make-or-break moment — over-communicate.

## Postmortem
- Classify: parser gap (new CRM export shape?) vs extraction quality vs dedupe logic vs pipeline bug. Parser gaps become E03 backlog items per source CRM.
- Update the import section of `07-onboarding-and-imports.md` with the new known shape.

## Known gaps
- Structured CRM-specific importers (Jobber/HCP exports) are E03 targets; today's structured-CSV path is generic.
- The recovery pipeline has never been live-smoked end-to-end (GO_LIVE_CHECKLIST §4 NEXT-3 still outstanding) — the first real import IS the smoke; schedule it as one, on a test shop.
- Phone normalization at the DB layer absent; import is where that debt bites first.
- Rollback of an *approved* import relies on the undo path — its blast-radius limits (interactions? CRM pushes through the seam?) REQUIRES VERIFICATION before promising "full rollback" to an owner.
