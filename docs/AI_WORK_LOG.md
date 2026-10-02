# AI work log

Every Claude Code, Cursor, and Codex session that changes Gradia appends one
entry here before it finishes. Read this file before starting so you do not
redo finished work or overwrite another tool’s uncommitted edit.

## Tag

Use this exact shape:

`[AI: cursor | claude-code | codex] [DATE: YYYY-MM-DD] [AREA: platform | marketing | docs | archive] [STATUS: done | in-progress | blocked]`

Then one short paragraph: what changed, the branch or PR, and what was
deliberately not done.

Do not tag a merge, deploy, or production change unless that session actually
merged, deployed, or changed production.

## Entries

[AI: cursor] [DATE: 2026-09-24] [AREA: docs] [STATUS: done]
Reconciled MVP documentation onto `codex/mvp-documentation-reconciliation`
and opened draft PR #49. Recorded the September 11 documents as authority,
PR #48 as merged draft-only Control Center code, and left founder `CONTEXT.md`
at local `20e153a` untouched. Did not implement features, merge, or deploy.

[AI: cursor] [DATE: 2026-09-24] [AREA: docs] [STATUS: done]
Recorded the founder trial decision: no free trial. A future exception, if
ever approved, is manual tools only and excludes AI. Recorded payments/POS as
a future intention, not current MVP. Described fleet accounts and full work
orders without adding them to the pilot. Added this log and the README rule.
Moved loose parent-folder clutter into `old-gradia-info/`. Did not move
`platform/`, `marketing/`, worktrees, or scripts.

[AI: cursor] [DATE: 2026-09-24] [AREA: docs] [STATUS: done]
Recorded the founder confirmation that full work orders are a future Gradia
product system, alongside payments and POS. Fleet accounts stay described
only. No build, merge, or deploy.

[AI: cursor] [DATE: 2026-09-24] [AREA: docs] [STATUS: done]
Recorded three future products, not in the MVP: win-back campaigns, Google
review request texts, and on-the-go owner access by texting a Gradia number
or an in-app Muse-style conversation. Same Agent. No build, merge, or deploy.

[AI: cursor] [DATE: 2026-09-24] [AREA: docs] [STATUS: done]
Added `docs/CHEAT_SHEET.md` and linked it from the README and `CLAUDE.md`.
No product code, merge, or deploy.

[AI: cursor] [DATE: 2026-09-24] [AREA: docs] [STATUS: done]
Corrected the diary `CONTEXT.md` on this branch so it no longer outranks the
five September 11 documents. Fixed the false "no data export" and "email is
read-only" lines, and stopped the build list from sending the next session to
billing. Founder checkout untouched. Parent `CLAUDE.md`, pricing, and
`WHAT_GRADIA_DOES.md` got the same warning. No application code.

[AI: cursor] [DATE: 2026-09-27] [AREA: platform] [STATUS: done]
Finished the local Control Center execution slice on
`codex/mvp-policy-execution` at `f2fccee`. Saving a draft still does nothing
until the owner activates that revision. The approval claim rechecks the
current policy, and catalog automations are marked automatic instead of
looking like an owner approval. Verified on the disposable test stack only:
1,024 unit tests passed with the four existing live skips, 210 integration
tests passed with zero skips, and the permission/rollback probe passed.
Preview deploy for this branch is disabled. Not pushed, merged, or deployed.
Manager approval stays owner-only. Direct tools, voice, alerts, and crons are
not covered by this claim.

[AI: codex] [DATE: 2026-09-29] [AREA: platform] [STATUS: done]
Resumed policy execution commit `f2fccee` without recreating completed work.
Finished disposable browser activation verification and reran 1,024 unit tests
(four intentional live skips), 210 integration tests (zero skips), lint, offline
Node 22 build and post-build typecheck. Corrected the historical 70→71 probe to
remove later dependent tables only inside its rolled-back transaction; all 72
ledger, permission, relationship and refusal probes pass. Existing editor and
executor reused; no second settings screen. The bounded execution slice is ready
for local review; complete direct-tool/transport policy coverage and delegated
manager approvals remain outstanding. No push, merge, deployment, production or
provider activity. Founder checkout and CONTEXT.md preserved. See the September 29
entry in `docs/architecture/CONTROL_CENTER_IMPLEMENTATION.md` for limitations.

[AI: codex] [DATE: 2026-09-29] [AREA: platform] [STATUS: done]
Added the bounded Agent capture adapter: owner-Agent notes/leads and MCP lead
proposals now use a durable, current-policy staging RPC and the existing approval
executor. Added migration 73, command retry binding, token revocation checks and
Shadow Mode enforcement. Verified 1,037 unit tests (four existing live skips),
220 integration tests (zero skips), fresh 73-migration initialization, all existing
migration probes, lint, offline build and post-build typecheck. Live model routing
evaluation remains unrun; capture prompt wording and its eval expectations now say
queued rather than saved. Direct customer edits/materialization and MCP memory
writes remain the next adapter work. This does not complete universal Control Center
coverage. No push, merge, deploy, production/provider action or founder-file change.

[AI: cursor] [DATE: 2026-10-01] [AREA: platform] [STATUS: done]
Finished the local record-command slice on `codex/mvp-policy-execution`.
Owner-agent customer edits, MCP identity resolution, and MCP reported history
now queue for review and commit only inside the existing approval claim.
Lead-only matches queue identity resolution instead of creating a customer or
disappearing. Customer and vehicle writes advance `updated_at`, so a stale
snapshot rolls back. Verified on the already-initialized disposable stack:
16 record integration tests, 30 adjacent integration tests, and 16 focused
unit tests passed; typecheck and touched-file lint passed. No from-zero reset,
full suite, build, browser pass, push, merge, or deploy. MCP read scoping,
voice, alerts, crons, and delegated manager approval remain uncovered.

[AI: codex] [DATE: 2026-10-01] [AREA: platform] [STATUS: done]
Completed verification and hardened the existing local record-command slice.
Customer/vehicle edits, identity resolution and reported history use existing
policy-controlled approvals with atomic domain write, audit and claim. Added
canonical lead identity comparison, field-bound vehicle snapshots and customer-bound
history references. Final Node 22 results: 1,048 unit tests passed (four intentional
live skips), 239 integration tests passed (zero skips), lint, offline build and
post-build typecheck passed. All 75 migrations initialized from zero in a separate
unlinked disposable stack; all migration probes and 26 relationship checks passed.
A fictional customer edit was approved in the local browser and verified in the
database with exactly one decision audit. Local preview preserved. Live model evals
and broader policy coverage remain outstanding as documented in
`docs/architecture/CONTROL_CENTER_IMPLEMENTATION.md`. Nothing pushed, merged,
deployed or sent to production/providers; protected founder checkout unchanged.

[AI: cursor] [DATE: 2026-10-01] [AREA: platform] [STATUS: done]
Added the first half of normalized lead intake on `codex/mvp-lead-intake`,
based on `a02fc97`. `record_lead_intake` writes one envelope and one workflow
transition in the same transaction, deduped on provider plus provider event id.
The shop id is an explicit argument. Contact text is stored only. The workflow
stays in `identity_review` with handoff pending. A duplicate, an out-of-order
explicit thread, and a replay after the row is saved keep a single record and
do not create a customer, lead, consent row, or approval. Focused result on
the already-initialized disposable stack: 3 unit tests, 4 integration tests,
touched-file lint, and typecheck passed. Migration `20261001130000` was applied
in place (ledger 76); no from-zero reset, full suite, or build. Did not wire
live SMS, the website form, Meta, or a Chief of Staff card, and did not change
owner-agent, MCP, approvals, or agent capture. Nothing pushed, merged, or deployed.

[AI: cursor] [DATE: 2026-10-01] [AREA: platform] [STATUS: done]
Wired the existing Twilio inbound SMS webhook on `codex/mvp-lead-intake` through
`record_lead_intake`. After signature verification and the provider-event claim,
each MessageSid writes one intake envelope and one workflow transition. A
duplicate delivery and a retry after the row is saved keep that single record;
the first payload wins, and the sender phone is not a thread key. The intake
write does not create a customer, lead, consent row, or approval. The existing
SMS path still resolves or creates a customer, applies STOP/START consent, and
stages `create_lead` for review when the classifier marks a lead. Verified on
the disposable stack: 5 lead-intake unit tests, 77 webhook unit tests, 5
lead-intake integration tests, and 14 Twilio inbound replay integration tests
passed; touched-file lint passed. No website-form handler exists in this tree,
so it was not built. Did not build Meta lead ads or a Chief of Staff card.
Nothing pushed, merged, or deployed.

[AI: cursor] [DATE: 2026-10-02] [AREA: platform] [STATUS: done]
Added website-form intake on `codex/mvp-lead-intake`. `POST /api/intake/website-form`
calls `record_lead_intake` once per caller-supplied submission id, with provider
`website_form`. This app has no website-form token or public form key — a quote
`public_token` identifies one quote, not a lead form — so the shop is the
signed-in owner's active shop. A missing shop, a body shop id that does not
match that session, or a submission id already stored for another shop does not
write. An unsigned body cannot name the tenant, and no public marketing site
was added. Submitted fields are stored as text. Phone and email are not a
thread key unless the caller sends one. The write does not create a customer,
lead, consent row, or approval. Disposable-stack result: 5 website-form
integration tests, 5 existing lead-intake integration tests, 14 Twilio inbound
replay integration tests, 9 lead-intake unit tests, 6 tenant-scoping unit tests,
and 77 webhook unit tests passed; touched-file lint and typecheck passed. Did
not build A2P, Twilio Trust Hub, Meta lead ads, or a Chief of Staff card, and
did not push, merge, or deploy.
