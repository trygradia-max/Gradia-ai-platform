# Releases

_Created 2026-07-25 by the Organizer. Governed by `../13-release-strategy.md`; dates in `../program/release-calendar.md`._

One record per release: `YYYY-MM-DD-<slug>.md`, written by the Release Reviewer at go/no-go time.

Each record contains: included tickets · migrations applied · flags flipped (before → after) · smokes performed (link GO_LIVE_CHECKLIST / `docs/*-go-live.md` items) · claim changes (WHAT_GRADIA_DOES deltas per D-028) · known issues shipped · rollback plan · go/no-go verdict with reasons.

## Index

_No formal release records yet. First expected record: the 2026-08-07 alpha (P0 exit)._

Release-infrastructure note (Organizer, 2026-07-30): **P0-002 CI enforcement merged to `main` (= production) in PR #9** with a green CI run — evidence in `../tickets/P0-002-ci-enforcement.md` (completion record). This shipped under the standing rule that reviewed P0-ticket batches may reach prod ahead of a formal release; from this date, every release record can rely on the "CI green" gate in `../13-release-strategy.md` being mechanically enforced (`ci / checks` + `ci-integration / integration` required on `main`). Completion/release evidence for P0-002 should cite PR #9 and its CI run.
