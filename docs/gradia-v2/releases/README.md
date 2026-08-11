# Releases

_Created 2026-07-25 by the Organizer. Governed by `../13-release-strategy.md`; dates in `../program/release-calendar.md`._

One record per release: `YYYY-MM-DD-<slug>.md`, written by the Release Reviewer at go/no-go time.

Each record contains: included tickets · migrations applied · flags flipped (before → after) · smokes performed (link GO_LIVE_CHECKLIST / `docs/*-go-live.md` items) · claim changes (WHAT_GRADIA_DOES deltas per D-028) · known issues shipped · rollback plan · go/no-go verdict with reasons.

## Index

_No formal release records yet. First expected record: the 2026-08-07 alpha (P0 exit)._

Release-infrastructure note (Organizer, 2026-07-30): **P0-002 CI enforcement merged to `main` (= production) in PR #9** with a green CI run — evidence in `../tickets/P0-002-ci-enforcement.md` (completion record). This shipped under the standing rule that reviewed P0-ticket batches may reach prod ahead of a formal release; from this date, every release record can rely on the "CI green" gate in `../13-release-strategy.md` being mechanically enforced (`ci / checks` + `ci-integration / integration` required on `main`). Completion/release evidence for P0-002 should cite PR #9 and its CI run.

P0-ticket batch note (docs-close session, 2026-08-11): **P0-004 conflict enforcement merged to `main` (= production) in PR #12** (`3b6d044`), `ci / checks` + `ci-integration / integration` green; review rounds addressed on-branch (`d43ce16` Cursor findings; `c0b66b1` founder rollout/failure-policy directives — no formal PR review verdict was filed; the founder merged). **Zero live behavior change at merge:** enforcement is dormant because `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT` defaults OFF (only the exact value `"true"` enables; build-time inlined, so changes require a redeploy). One additive idempotent migration shipped (`20260806120000_appointments_shop_scheduled_idx.sql`). Per §Standing rules the **production flag flip is the release event** and gets the formal record — it is gated on the founder executing the ticket's manual acceptance steps 1–7 on a flag-on Preview. No claims changed (D-028). Merge/review record: `../tickets/P0-004-conflict-enforcement-booking-paths.md`.

P0-ticket batch note (Organizer, 2026-08-06): **P0-003 central appointment conflict service merged to `main` (= production) in PR #10** (`00091db`), Cursor Reviewer verdict APPROVE, `ci / checks` + `ci-integration / integration` green after the review commit. **Zero user-facing surface**: the service (`src/lib/availability.ts`) is dormant until P0-004 wires it into booking paths behind `FEATURES.conflictEnforcement` — under §Standing rules, that future **flag flip is the release event** and gets the formal record; this note is the merge evidence. No migrations, no flags flipped, no claims changed (D-028: nothing new claimable). Merge/review record: `../tickets/P0-003-central-appointment-conflict-service.md`.
