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
