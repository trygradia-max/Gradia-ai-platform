# PROD-CONFIG-AUDIT — Production configuration audit (docs-only output)

_Cut 2026-09-01 by the Organizer for autorun Batch 1 (`../program/autorun.md`). Specification only. Output is a document; no code changes._

## Ticket ID
PROD-CONFIG-AUDIT

## Epic
E00 — Stabilization (operational hygiene; feeds P0-012, P0-013, CLEANUP-001, E02-03/04 preconditions)

## Status
**ready — autorun Batch 1, queue item 1** (first item on `auto/batch-1`). Risk class **none** (read-only; writes one markdown file). Founder acceptance **no**. No decisions block it. Precondition 4 in autorun.md (founder sets the seven Production vars) may or may not have happened before this runs — the audit records whichever is true.

## Priority
P0 band — Medium. Every "Coming soon" tile in `/settings` is driven by env absence (`settings/page.tsx:129-149` → `connection-tile.tsx:50-52`), so a missing server secret is currently presented to owners as a roadmap message; nobody has one table that says which of the 50 env reads are required, which are optional, and which are present in Production.

## Objective
Produce `docs/gradia-v2/runbooks/production-config-audit.md`: every `process.env.X` read under `src/`, classified required/optional per code path, compared against Vercel Production (via `vercel env ls production` if the CLI is authenticated in the session; otherwise against `docs/env-setup.md` + `.env.example`, clearly labeled as UNKNOWN for presence), with a PRESENT / ABSENT / UNKNOWN table and, for each absent var, exactly which UI surfaces and code paths it disables.

## User outcome
Founder-as-operator: one page answers "what is Gradia actually configured to do in production, and what does each missing secret turn off?" before autorun flips anything. Owners benefit later: PROD-CONFIG-AUDIT's disabled-surface column is the input for replacing "Coming soon" with honest NOT AVAILABLE copy (the copy change itself rides the first ticket that touches each tile — E02-03 for calendar/email; P0-013 for billing).

## Current code references
- **50 distinct `process.env.X` names under `src/`** (Explore sweep 2026-09-01; representative sites): `ANTHROPIC_API_KEY` `src/lib/draft-verifier.ts:121` · `AURINKO_API_BASE` `src/lib/aurinko.ts:29` · `AURINKO_CLIENT_ID` `src/app/api/aurinko/auth/start/route.ts:51` · `AURINKO_CLIENT_SECRET` `settings/page.tsx:132` · `AURINKO_SIGNING_SECRET` `aurinko.ts:672` · `CRON_SECRET` `src/app/api/admin/margin-report/route.ts:18` · `ENCRYPTION_KEY` `src/lib/crypto.ts:43` · `GLOBAL_DAILY_COST_CEILING_CENTS` `src/lib/monitoring.ts:129` · `GRADIA_DASHBOARD_URL` `src/app/actions/twilio-provision.ts:22` · `GRADIA_LLM_MODEL` `src/lib/bi-agent.ts:27` · `HOUSECALLPRO_CLIENT_ID/SECRET` `src/app/api/housecallpro/auth/start/route.ts:44`, `settings/page.tsx:148` · `JOBBER_CLIENT_ID/SECRET` `src/app/api/jobber/auth/start/route.ts:43`, `settings/page.tsx:144` · `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT` `src/lib/features.ts:72` · `NEXT_PUBLIC_SENTRY_DSN/ENVIRONMENT` `src/instrumentation-client.ts:9,21` · `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` `stripe-embedded-onboarding.tsx:51` · `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY` `src/app/auth/callback/route.ts:6-7` · `NEXT_PUBLIC_VERCEL_ENV` `instrumentation-client.ts:22` · `NEXT_RUNTIME` `src/instrumentation.ts:30` · `NODE_ENV` `src/app/actions/shop.ts:47` · `OPENAI_API_KEY` `src/lib/embeddings.ts:20` · `SENTRY_DSN/ENVIRONMENT` `instrumentation.ts:15,26` · `SLACK_BOT_TOKEN/DEFAULT_CHANNEL_ID/SIGNING_SECRET/WEBHOOK_URL` `src/lib/slack.ts:173,174,1195,192` (+ `src/lib/reconciliation.ts:86`) · `STRIPE_API_BASE` `src/lib/stripe.ts:19` · `STRIPE_CONNECT_CLIENT_ID` `stripe-connect.ts:33` · `STRIPE_PRICE_CREDIT_PACK/ID/MINUTE_PACK/VOICE_ADDON` `stripe.ts:291,269,292,285` · `STRIPE_SECRET_KEY` `stripe-connect.ts:32` · `STRIPE_WEBHOOK_SECRET` `stripe.ts:447` · `SUPABASE_SERVICE_ROLE_KEY` `src/lib/supabase/service.ts:9` · `TWILIO_ACCOUNT_SID/AUTH_TOKEN` `settings/page.tsx:135-136` · `TWILIO_API_BASE` `src/lib/twilio.ts:189` · `TWILIO_MESSAGING_API_BASE/TRUSTHUB_API_BASE` `src/lib/twilio-a2p.ts:23,21` · `TWILIO_PRIMARY_PROFILE_SID` `src/lib/telephony-provider.ts:285` · `VAPI_API_BASE` `src/lib/vapi.ts:17` · `VAPI_API_KEY` `settings/page.tsx:129` · `VAPI_DEFAULT_SHOP_ID` `src/app/api/vapi/webhook/route.ts:194` · `VAPI_WEBHOOK_SECRET` `vapi/webhook/route.ts:163` · `VERCEL_ENV` `instrumentation.ts:26`. The Builder re-derives this list by grep (the sweep is evidence, not the deliverable).
- Env-driven tiles: `src/app/(dashboard)/settings/page.tsx:129-149` (six booleans) → `available={…}` at `:270,:281,:293,:312,:326,:338`; renderer `src/components/gradia/connection-tile.tsx:50-52` ("Coming soon" badge) and `:65-66` (comment "Built but not yet wired for this workspace").
- Central validator: `src/lib/env.ts` (13 lines) covers only the two public Supabase vars.
- Docs: `docs/env-setup.md` (Slack rows `:59-62`; **no Housecall row**), `.env.example` (`AURINKO_API_BASE`, `GRADIA_LLM_MODEL`, `TWILIO_PRIMARY_PROFILE_SID`, `*_API_BASE` seams undocumented per the P0-010 close).
- Recorded production facts to carry into the table: `GRADIA_DASHBOARD_URL` PRESENT (P0-010 close); `STRIPE_PRICE_*` intentionally ABSENT until P0-013 (Q-22/D-034 guard); autorun precondition 4 lists `VAPI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `AURINKO_CLIENT_ID`, `AURINKO_CLIENT_SECRET`, `CRON_SECRET`, `VAPI_DEFAULT_SHOP_ID` as founder-to-set.

## Exact scope
1. Enumerate every `process.env.<NAME>` (and `process.env["NAME"]`) read under `src/` with all sites (file:line), deduped by name.
2. Classify each: **required** (app or a P0 invariant fails closed/crashes without it — name the path), **required-for-feature** (a product surface is disabled without it — name the surface + the UI copy the owner sees), **optional/dev-only** (test seams, `*_API_BASE`, `GRADIA_LLM_MODEL`), **deprecated-by-decision** (`HOUSECALLPRO_*`, Slack approvals vars → CLEANUP-001/D-052; `AURINKO_*` → D-050 retirement in Batch 4; `STRIPE_PRICE_*` legacy SKUs → P0-013).
3. Presence: if `vercel` CLI is present **and already authenticated** (`vercel whoami` succeeds without prompting), run `vercel env ls production` read-only and mark PRESENT/ABSENT; otherwise mark **UNKNOWN** and cite `docs/env-setup.md`/`.env.example` expectations. **Never** run `vercel login`, `vercel env add/pull`, or any mutating command (autorun rule 6). Also mark the two documented facts above (PRESENT `GRADIA_DASHBOARD_URL`, ABSENT-by-design `STRIPE_PRICE_*`) from the record.
4. Write `docs/gradia-v2/runbooks/production-config-audit.md`: (a) method + date + whether presence was verified or inferred; (b) the table `Var · Class · Read sites · Production: PRESENT/ABSENT/UNKNOWN · Disabled surfaces/paths when absent · Owner-visible copy today · Decision/ticket`; (c) findings: undocumented vars (`.env.example`/`env-setup.md` gaps), vars read but never documented, vars documented but never read, the "Coming soon" misrepresentation list; (d) recommended founder actions (precondition 4 confirmation) and the ticket that owns each copy fix — **recommendations only; no code**.
5. Cross-link from `runbooks/exposed-credential.md`, `docs/env-setup.md` (one line), and `program/capability-status.md` (one line).
6. **ICP docs pass (per autorun.md §UI direction, 2026-09-01):** add a short D-036 amendment to `docs/gradia-v2/ui/design-north-star.md` and `docs/gradia-v2/ui/navigation-model.md` — the audience is established shops with staff (multi-bay, 2+ people); role-aware navigation (D-048/E01-03) and the per-phase 9-item convergence (D-049) are the direction; no design-language change. Two short paragraphs, dated, citing D-036/D-048/D-049 — documentation only.

## Explicit non-goals
- No code changes, no `.env*` edits, no env var creation, no `src/lib/env.ts` validator (a follow-up ticket may add one — recommend it in the findings).
- No secret values recorded anywhere — names and presence only.
- No copy changes to tiles (owned by the tickets named in the table).

## Dependencies
None technical. Decisions: none. Reads D-052 (HCP/Slack delete), D-050 (Aurinko), D-034 (`STRIPE_PRICE_*` guard) to classify.

## Expected modules affected
None in `src/`. New `docs/gradia-v2/runbooks/production-config-audit.md`; one-line cross-links in `docs/env-setup.md`, `runbooks/exposed-credential.md`, `program/capability-status.md`; short ICP amendments in `ui/design-north-star.md` and `ui/navigation-model.md` (scope 6).

## Database impact
None.

## Migration impact
None.

## API impact
None.

## UI impact
None.

## Permission impact
None.

## Tenant-isolation impact
None (no shop data touched).

## Security impact
The document must contain no secret values, no partial values, no hashes of values. `vercel env ls` output lists names only — still, redact anything that is not a name before pasting. Review checklist item.

## Idempotency requirements
Re-running the audit regenerates the same table (deterministic grep + sorted names).

## Observability requirements
None.

## Analytics requirements
None.

## Feature flag
None — documentation.

## Automated tests
None added. **Optional** (only if trivially small and clearly in scope of "docs-only": none — do not add a source-scan test here; recommend it in findings for the env-validator follow-up).

## Manual acceptance procedure
1. Builder: re-run the grep; the table row count equals the deduped name count; every row has ≥ 1 file:line.
2. Builder: for three "required-for-feature" rows, open the named surface with the var absent (local) and confirm the described disabled state matches.
3. Builder: confirm the document contains no value-shaped strings (regex scan for `sk_`, `whsec_`, `AC[0-9a-f]{32}`, `eyJ`, URLs with credentials).
4. Reviewer: spot-check five rows against code.

## Failure cases
- CLI present but not authenticated → UNKNOWN column, stated at the top; no login attempted.
- Grep misses dynamic reads (`process.env[name]`) → search both forms + `env.ts`; list any indirection found.

## Rollback strategy
Delete the document (no other state).

## Definition of done
`../12-definition-of-done.md` as applicable to a docs ticket (A, G, H): the runbook exists with the method statement, full table, findings, and owner-ticket mapping; cross-links added; no secrets; `autorun-log.md` block written; commit message `docs(PROD-CONFIG-AUDIT): production configuration audit`.
