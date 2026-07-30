# 13 — Release Strategy

_Created 2026-07-25 by the Organizer. How code reaches production and how claims reach the public. Complements `GO_LIVE_CHECKLIST.md` (deploy/smoke detail) and `12-definition-of-done.md` (per-ticket bar)._

## 1. Branch & deploy model

- **`main` = production.** Vercel deploys on merge; crons auto-register from `vercel.json`.
- All work happens on feature/ticket branches; PRs into `main`; no direct pushes.
- Because main is production, **CI must be able to stop a broken build** — P0-002 is therefore a release-infrastructure prerequisite, not an ordinary ticket.
- Migrations are applied to prod in filename order before/with the deploy that needs them (GO_LIVE_CHECKLIST §1 pattern); additive-only unless a ticket explicitly says otherwise.

## 2. Release gates (in order)

A change may merge/ship only when:

1. **CI green** — typecheck, lint, unit, build, integration (post-P0-002).
2. **DoD met** — full checklist in `12-definition-of-done.md`, Builder completion report filed.
3. **Cursor Reviewer sign-off** on the diff vs the ticket spec.
4. **Release Reviewer sign-off** for anything that: touches money/ledgers, tenancy/RLS, scheduling writes, provider webhooks, autonomy gates, or flips a feature flag in production.
5. **Provider-touching work** additionally walks the relevant `docs/*-go-live.md` runbook and the GO_LIVE_CHECKLIST smoke for that surface.

**Known deviation — staging acceptance (recorded 2026-07-27).** The founder operating pattern includes a "staging acceptance" step before merge. No dedicated staging environment exists today (Vercel/Supabase staging tiers: requires verification, `vendors/registry.md`). Until one exists, the **Vercel preview deployment of the ticket branch is the staging surrogate**: the ticket's manual acceptance procedure runs against the preview deploy (with a seeded shop) before merge, and the completion report names the preview URL used. This deviation is deliberate and recorded — not silence; standing up a real staging environment is E10-scope unless pulled earlier by founder decision.

## 3. Feature-flag discipline

- Incomplete or high-risk functionality ships **dark** behind `features.ts` flags (D-027); gate, don't delete.
- **Smoke before flip:** a flag flips on in production only after its GO_LIVE_CHECKLIST-style smoke passes on a seeded/staging shop (the §4→§5 order in that checklist is the model — e.g. customerRecovery stays OFF until its full smoke passes).
- Flag flips are releases: they get a release record (§4), a Release Reviewer sign-off, and a rollback note ("flip back + redeploy").
- `slackApprovals` stays `false` per D-026 — flipping it requires the tenant-authorization rebuild plus an ADR; no smoke can override that.

## 4. Release records

Every production release (merge that deploys, migration application, or flag flip) gets a file:

```
releases/YYYY-MM-DD-<slug>.md
```

containing: what shipped (tickets/epics) · migrations applied · flags changed · smokes executed + results · known issues · rollback procedure · claim changes (§6) · sign-offs (Builder, Cursor Reviewer, Release Reviewer). **Ownership (clarified 2026-07-27):** for releases in the risky classes of gate 4, the Release Reviewer owns the record; for ordinary merges that deploy without Release-Reviewer involvement, the **merging Builder writes the record** as part of the DoD documentation step and the Organizer indexes it. Every production release has a record either way — no release is exempt. Indexed in `program/release-calendar.md`.

## 5. Rollback rules

1. **Flags first:** the fastest rollback is flipping the feature's flag off and redeploying — every risky surface must have one (that's why D-027 exists).
2. **Code rollback** (revert + redeploy) never requires a DB rollback while migrations stay additive.
3. **Migrations:** additive migrations are left in place on rollback; destructive migrations are forbidden without a founder-approved decision + tested down-path.
4. **Never roll back ledgers.** `usage_events`, `payments`, `credit_grants` are append-only (D-024) — bad financial rows are corrected with offsetting entries, documented in the release record.
5. Data written by a rolled-back feature is assessed in the release record (e.g. the recovery bucket's PII purge note in GO_LIVE_CHECKLIST §7).

## 6. Claims promotion (D-028)

Product claims must distinguish **live / beta / planned**:

- `_docs/WHAT_GRADIA_DOES.md` remains the claim list; `04-capability-map.md` statuses (internal/pilot/public) are the machine-readable source.
- A capability's claim moves to "live" only at **public** status (evidence bar in `09-testing-strategy.md` §6). Pilot = "early access" wording at most. Planned features are never marketed as existing.
- Claim changes ride the release record that earns them; the marketing site does not auto-deploy — copy releases are triggered explicitly and checked against WHAT_GRADIA_DOES.
- Standing examples: voice/telephony is built-not-claimable until its acceptance run passes; customer recovery is unmentionable until its smoke passes.

## 7. Alpha — 2026-08-07

- **Scope = P0 complete.** All 12 P0 tickets done; nothing from P1+ blocks or rides the alpha.
- Pre-alpha additionally requires: home-redesign branch merged (its Phase 5 verify finished), owner acceptance runs from GO_LIVE_CHECKLIST, founder-ops items from `FOUNDER_OPS_RUNBOOK.md` (A2P, env verification) — tracked in `program/release-calendar.md`.
- Alpha posture: single-digit shops, founder-supervised, SEV runbooks in place (`runbooks/`), alerting live (P0-012).

## 8. Cadence

No fixed release train at this scale: ship when gates pass, batch flag flips behind smokes. The Organizer maintains `program/release-calendar.md` (planned releases, migration windows, claim promotions); the Release Reviewer may hold any release that lacks its record or sign-offs.
