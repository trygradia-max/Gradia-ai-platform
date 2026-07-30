# P0-010 — Production environment and error-surface cleanup

## Ticket ID
P0-010

## Epic
E00 — Stabilization

## Status
**ready-after-P0-002** (reconciled with the index 2026-07-27) — no technical dependencies, no open decisions; enters review only after P0-002 per the global review gate. Batch ticket: each item is independently small; the ticket is done when all items land.

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
- The code-side prod guard for `VAPI_DEFAULT_SHOP_ID` lives in **P0-007** — this ticket only verifies the env var is unset operationally.

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
