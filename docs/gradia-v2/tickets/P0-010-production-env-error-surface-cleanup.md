# P0-010 — Production environment and error-surface cleanup

## Ticket ID
P0-010

## Epic
E00 — Stabilization

## Status
**done** (2026-08-28 — merged to `main` in PR #27, merge commit `5d82fa3`; reviewed/accepted implementation tree `618cf41` = Builder `aea2d41` → Cursor review-fix `618cf41`; independent Cursor verdict **APPROVE**, one HIGH found and fixed pre-merge; founder acceptance **PASS 2026-08-28** on the exact reviewed commit. Full close record appended below. Process note: the unblock condition — the `docs/close-p0-009` closeout landing on `main` — was satisfied 2026-08-26 as `e70b287` PR #26; like P0-004 through P0-009, this ticket then ran founder-slotted without the status line or boards being flipped at start — corrected retroactively at this close.)

## Priority
P0 — Medium-high. Individually small; collectively they are the difference between "silently broken in prod" and "fails loudly with a recovery path". Includes one MEDIUM security finding (M-1).

## Objective
Close the pre-alpha environment and error-surface gaps from audit docs 08 and 12 (item 7): undocumented env vars, the unauthenticated LLM action, missing error boundaries and loading states, stale cache targets and copy, orphaned modules, and the `VAPI_DEFAULT_SHOP_ID` prod verification.

## User outcome
An owner who hits a server error sees a designed, written error screen instead of a raw Next.js default; every settings surface tells the truth about the Slack-less approval flow; and the founder can deploy knowing every required env var is documented and no anonymous caller can burn Anthropic tokens.

## Current code references
- **Env vars:** 5 missing from `.env.example`: `STRIPE_PRICE_VOICE_ADDON`, `STRIPE_PRICE_CREDIT_PACK`, `STRIPE_PRICE_MINUTE_PACK`, `STRIPE_API_BASE`, `GLOBAL_DAILY_COST_CEILING_CENTS` (audit doc 12 item 7; "missing env vars would 500 voice checkout" doc 10).
- **M-1:** `processRawLeadNote` (`src/app/actions/ai-lead.ts:24`) — POST-invocable by anyone, calls Anthropic, no `requireUser`, no metering, no rate limit (audit doc 06 M-1).
- **Error boundaries:** zero `error.tsx`/`global-error.tsx`/`not-found.tsx` anywhere in `src/app` (audit doc 08).
- **Loading states:** missing `loading.tsx` for customers routes, `/calendar`, `/receptionist`, `/settings` (audit doc 08).
- **Stale revalidatePath:** `actions/custom-agents.ts:136,158,190,245` → `"/agents"`; `actions/autonomy.ts:48` → `"/agents"`; `actions/recovery.ts:165,336` → `"/recovery"`; `actions/approvals.ts:48` → `"/leads"` (audit doc 08).
- **Stale copy:** `src/lib/data/agents.ts` catalog prose claims Slack approval surface (`:162,183,194,226,246`) and links `/chat` (`:242`); `features.ts:41` dead `askGradiaPage` flag; `data/customers.ts:19` docstring claims IG/FB search (audit doc 08).
- **Orphans (zero importers, grep-verified in audit doc 08):** `components/gradia/co-owner-card.tsx`, `lib/data/co-owner.ts`, `components/gradia/schedule-groups.tsx`, `lib/data/revenue.ts`, `lib/data/today-money.ts`, `lib/data/interactions.ts`, `components/ui/badge.tsx`, `components/ui/scroll-area.tsx`.
- **Design nit:** raw `text-amber-600` classes on env-gated settings fallbacks (semantic-token rule violation, audit doc 08 mock-hunt table).
- **Footgun:** `VAPI_DEFAULT_SHOP_ID` must be unset in prod (audit trace H; open question #18).
- **H-1:** `.env.local` backup pile in repo root (audit doc 06 H-1) — founder-executed deletion, checklisted here.

## Exact scope
1. Document the 5 env vars in `.env.example` with one-line comments (names + purpose only, never values).
2. Auth-gate `processRawLeadNote`: `requireUser`/`requireShop`, zod input, rate limit via existing `rate-limit.ts`, metering per credit rules if the action stays; if the action is orphaned (verify importers first), delete it instead — cheaper and safer.
3. Add `error.tsx` and `not-found.tsx` at the `(dashboard)` layout level (written copy via `strings.ts`, per EmptyState discipline: no blank screens); add `global-error.tsx` minimal.
4. Add the four missing `loading.tsx` files (skeletons, matching existing sections' pattern).
5. Fix the four stale `revalidatePath` target groups to the live IA routes.
6. Rewrite `agents.ts` catalog prose: in-app approvals, `/conversations` link; fix `customers.ts` docstring; remove the dead `askGradiaPage` flag.
7. Delete the 7 orphaned modules + verify no importers at delete time (re-grep, don't trust the audit's snapshot).
8. Replace raw amber classes with `--status-warning` tokens on the named settings cards.
9. **Founder checklist items (in the completion report, not code):** verify `VAPI_DEFAULT_SHOP_ID` unset in Vercel prod env; delete the `.env.local` backup variants (H-1). Code cannot do these; the ticket is not done until the founder confirms.

## Explicit non-goals
- No structured-logger adoption (roadmap P10).
- No Sentry configuration changes (P0-012 owns alerting).
- No root-directory doc-clutter sweep (post-merge task per audit doc 08; blocked on the home-redesign branch merging).
- No redesign of settings cards beyond token compliance.
- No `tracesSampleRate` changes.
- The code-side prod guard for `VAPI_DEFAULT_SHOP_ID` lives in **P0-007** (shipped 2026-08-14, PR #21 — the production fallback now fails closed for unmatched assistants) — this ticket only verifies the env var is unset operationally.

## Dependencies
None. May run in parallel with anything (low collision risk — mostly additive files and copy).

## Expected modules affected
- `.env.example`
- `src/app/actions/ai-lead.ts` (gate or delete)
- `src/app/(dashboard)/error.tsx`, `not-found.tsx`, `src/app/global-error.tsx` (new)
- Four new `loading.tsx` files
- `src/app/actions/{custom-agents,autonomy,recovery,approvals}.ts` (revalidatePath strings)
- `src/lib/data/agents.ts`, `src/lib/data/customers.ts`, `src/lib/features.ts`
- Seven deleted files
- Settings card components (amber → token)
- `src/lib/strings.ts` (error/not-found copy)

## Database impact
None.

## Migration impact
None.

## API impact
- `processRawLeadNote` becomes authenticated (or removed) — breaking only for unauthenticated callers, which is the point. Verify no legitimate unauthenticated consumer exists first.

## UI impact
- New error/not-found/loading surfaces: each needs written copy (narrator voice, Language Pack rules), no dead controls, a clear primary action (error → retry/home), mobile-correct, accessible (focus lands on the message; role="alert" where appropriate).
- Amber → `--status-warning` visual change on settings fallbacks.

## Permission impact
- M-1 fix adds auth where there was none. No other changes.

## Tenant-isolation impact
- M-1 fix scopes the action to the caller's shop. Nothing else touches tenancy.

## Security impact
- Closes M-1 (unauthenticated LLM token burn / cost DoS).
- H-1 secret-file cleanup (founder-executed) reduces local leak surface.
- Env documentation prevents fail-open/500 misconfigurations at deploy.

## Idempotency requirements
Not applicable (no event processing). `revalidatePath` fixes are inherently idempotent.

## Observability requirements
- `error.tsx` boundaries must report to Sentry (already wired app-wide — confirm the boundary doesn't swallow the event).
- No other new signals.

## Analytics requirements
None.

## Feature flag
**None — cleanup.** Justification: every item either fixes verified dead/stale code or adds fail-safe surfaces; none changes product behavior for a healthy path. Deletions are revert-recoverable.

## Automated tests
- **Unit/failure-path:** `processRawLeadNote` rejects unauthenticated calls; rate limit binds; zod rejects oversize input (if kept).
- **Build/typecheck:** deletions compile clean (`tsc --noEmit`, `next build` — CI now enforces these per P0-002; if P0-002 hasn't merged, run locally and note it).
- **Smoke/E2E-lite:** a route that throws renders the new error boundary (component test or Playwright-lite if available; otherwise manual step 3).
- **Source-scan test (cheap lock):** no `revalidatePath` call references a redirect-stub route — prevents recurrence.

## Manual acceptance procedure
1. `git grep` each deleted module name → zero importers; app builds and boots.
2. Visit `/receptionist` → catalog prose describes in-app approvals, links `/conversations`.
3. Force a server-component throw on a dashboard route (temporary dev-only) → designed error screen with written copy and a working recovery action; Sentry event recorded.
4. Visit a nonexistent dashboard path → designed not-found.
5. Throttle network; open `/customers`, `/calendar`, `/receptionist`, `/settings` → skeletons, not blank frames.
6. Approve an action → `/customers` (not `/leads`) revalidates; save a custom agent → `/receptionist` revalidates.
7. Unauthenticated POST to the `ai-lead` action endpoint → rejected (or 404 if deleted).
8. Settings fallback cards render with `--status-warning` tokens (inspect: no raw amber hex/class).
9. Founder confirms in writing: `VAPI_DEFAULT_SHOP_ID` absent from prod env; `.env.local` backups deleted.

## Failure cases
- An "orphan" gained an importer since the audit → skip that deletion, note it in the completion report (never force-delete).
- `error.tsx` boundary itself throws → `global-error.tsx` catches (test the nesting once).
- `ai-lead` action has a real unauthenticated consumer discovered → stop, escalate to decision queue rather than break it silently.

## Rollback strategy
Revert the PR (all changes are code-only). Deletions restore from git. Founder env steps are independent and reversible in the Vercel dashboard.

## Definition of done
Per `12-definition-of-done.md`, plus: every scope item checked off individually in the completion report (batch tickets die by vagueness), founder confirmations (item 9) recorded, and the re-grep evidence for each deletion included.

---

## Close record (2026-08-28)

**Merged:** PR #27 "fix: harden production env and error surfaces", merged to `main` 2026-08-28T17:13:23Z as `5d82fa3`. Reviewed/accepted implementation tree: **`618cf41`** (Builder `aea2d41` 2026-08-26 → Cursor review-fix `618cf41`). CI on the exact reviewed commit: `ci / checks` PASS · `ci-integration / integration` PASS · Vercel Preview PASS.

**Review:** independent Cursor verdict **APPROVE**. One HIGH found and fixed pre-merge in `618cf41`: AI-lead extraction reused `inbound_classify` via `priceUsage()` credits, which rounds the zero-retail SKU up to 1 — the action would have consumed 1 shop credit per extraction. Fix passes `credits: 0` explicitly (same contract as Twilio/Aurinko inbound classify) and locks it in the unit test with a rounding trap.

**Founder acceptance: PASS 2026-08-28** on isolated local staging (local Supabase + `next start` production build; production untouched; staging tenants purged after). Evidence: local/origin/PR heads all `618cf41`; 633 unit + 101 integration tests green, `tsc` and production build clean at that commit. Verified live: unauthenticated server-action replay of the M-1 attack refused with zero writes; authenticated extraction succeeded via a real model call; tenant isolation (shop derived from session, no caller-supplied tenant input exists; bystander shop untouched across all probes); inactive-plan and exhausted-credit 402 refusals pre-model with zero ledger rows; successful extraction wrote exactly one `usage_events` row `kind=inbound_classify, credits=0` (wholesale 0.2¢ / retail 0) with the shop's 1,200-credit balance unchanged; provider/model failure (invalid key) created no usage row and no decrement; `ai_lead` rate limit exactly 20/60s per server-derived shop with cross-shop bucket isolation; dashboard error boundary rendered designed copy inside the sidebar shell with working Try again / Back to Home and production-redacted errors (digest only — no stack); dashboard not-found rendered with recovery; all four `loading.tsx` routes stream skeleton fallbacks (no fake data); revalidation targets verified by diff + the source-scan test; copy truth verified (zero Slack refs in `agents.ts`, Conversations not `/chat`, IG/FB claim removed); env-backup hygiene clean (no `.env.local.bak*`/`.save*`/`.pre-restore*`/`.env.production.pull*`); orphan deletions regression-free with retained `revenue.ts`/`today-money.ts` live; P0-007 Vapi production fail-closed guard untouched and green.

**Scope item 9 (founder confirmations) — recorded:** founder manually confirmed in Vercel Production: `GRADIA_DASHBOARD_URL` PRESENT; `VAPI_DEFAULT_SHOP_ID` ABSENT; `STRIPE_API_BASE` ABSENT. `.env.local` backup variants confirmed absent (H-1 closed).

**Production billing exception (recorded as PASS behavior, not a failure):** `STRIPE_PRICE_ID`, `STRIPE_PRICE_VOICE_ADDON`, `STRIPE_PRICE_CREDIT_PACK`, `STRIPE_PRICE_MINUTE_PACK` are **intentionally ABSENT from Production**. The current billing implementation still encodes the legacy Core $20 + Voice $29 model (C-14), so Production checkout must remain fail-closed. Acceptance proved empirically that with the price ids absent, every checkout path throws before any Stripe API call — no Checkout Session is created, no charge is possible, no local plan/subscription state changes. **Do not set these variables until P0-013 — Production billing model alignment — is implemented, reviewed, accepted, and ready for Production. P0-013 is launch-blocking before live paid billing activation** (see `P0-013-production-billing-model-alignment.md`, Q-22).

**Builder deviations from spec (all verified at acceptance):** `askGradiaPage` flag kept — it gained a real consumer since the audit (comment corrected instead); `data/revenue.ts` + `data/today-money.ts` skipped — no longer orphaned (live dashboard importers); `ui/badge.tsx` already deleted at HEAD; settings amber classes already token-compliant at HEAD (nothing to do); customers/settings `loading.tsx` already existed (calendar + receptionist added); root `error.tsx`/`global-error.tsx`/`not-found.tsx` already existed ((dashboard)-level pair added). Five of the seven listed orphans deleted, each with a fresh re-grep at delete time.

**Residual findings (recorded, not repaired — Organizer sequences):**
- **M-1** — provider/model error details may surface raw to the owner (reproduced at acceptance: a `401 …` provider string reached the UI on model failure).
- **M-2** — AI-lead extraction and inbound classification share the `inbound_classify` analytics kind, mixing the two in usage analytics.
- **M-3** — two API routes still revalidate the legacy `/leads` stub (outside the ticket's `app/actions` scope and the source-scan test's coverage).
- **M-4** — this docs closeout (satisfied by the `docs/close-p0-010` commit carrying this record).
- LOW/OPTIONAL: the accepted Builder/Cursor residuals above stand as documented; no scope expansion.

**Correction to the P0-013 discovery report:** that report claimed `inbound_classify` is missing from the `usage_events` kind CHECK constraint. **The claim is false** — migration `20260713130000_master_audit_perf.sql` already widens the constraint and seeds the SKU's `pricing_config` row, and acceptance inserted the kind successfully on a migrations-built database. No follow-up ticket exists or should be created for it.

**Process deviations:** acceptance browser tooling wrote snapshot artifacts inside the pre-existing untracked `.playwright-mcp/` directory (tooling noise only — never staged, not product code). Production conflict enforcement remains **OFF** throughout.
