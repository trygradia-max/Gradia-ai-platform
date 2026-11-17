# Resume: Provider Boundary V1 (public SMS + email classification and immediate drafting)

Branch `claude/provider-boundary-sms-email`. Owner: Claude Code. **Do not merge.**
Base commit: `b3694ce8e65fe3c8d1bc413528623757dda3e803` (origin/main at start, 2026-11-16).

## Scope

First bounded Gradia-owned model/provider security boundary for PUBLIC inbound SMS and email:
classification (`sms-classifier.ts`, `email-classifier.ts`) and immediate drafting (`sms-drafter.ts`,
`email-drafter.ts`) only. Out of scope: billing, voice/Vapi, Agent OS storage, embeddings, deploy,
shared DBs, secrets, customer data, production, model credentials, live evals, any CRM mutation,
any weakening of approval, automatic multi-model fallback.

## Threat model (working draft)

Untrusted: message body, subject, sender display name, retrieved shop knowledge. Attacker goals:
role/policy override, tool use / exfil of secrets or system prompt, alternate recipient, fake consent /
price / booking / tool authority, bidi/zero-width/control smuggling, oversized input, malicious
structured output, replay, bypass of STOP, cross-tenant leakage, PII/secrets in logs.

Controls: deterministic preflight -> hold for human (raw evidence preserved, no draft/proposal/CRM/send);
PII-minimized bounded model input; strict output validation; model output never selects tenant,
recipient, channel, consent, purpose, policy, tool, price, booking or execution authority; provider
failure -> truthful hold; no raw content/credentials/prompts/PII in logs.

## Milestones

- [x] M0 reading + audit (AGENTS.md, AI_WORK_LOG, five governing docs, AGENT_OS_LAYERING, AGENTIC_OS_MASTER_BUILD,
      PRODUCTION_LAUNCH_READINESS, Next route-handler docs: no route-convention change needed)
- [x] M1 boundary module `src/lib/provider-boundary/` (text, redact, preflight, output-policy, log, run, hold) — commit 2358937
- [x] M2 SMS/email classifiers + inbound drafters migrated; Twilio SMS + Aurinko routes wired — commit b7d33e2
- [x] M3 adversarial tests: unit (`eval/provider-boundary.test.ts`, 124) + route (`eval/provider-boundary-routes.test.ts`, 50)
- [x] M4 docs (`docs/architecture/PROVIDER_BOUNDARY.md`), AI_WORK_LOG entry, origin/main re-checked (unchanged at b3694ce, no rebase needed), full checks, PR opened (non-draft; DO NOT MERGE from this session)

## Key design decisions

- Preflight runs BEFORE any CRM write or model call (in the route and again inside classifier/drafter).
- Hold = raw evidence already stored (interaction row; SMS also the intake envelope) + ONE content-free, idempotent
  `system`-role interaction note (`metadata.boundary_hold_key = stage:sourceRef`). No pending action, customer
  (read-only lookup for held), lead, draft, send. Exactly-once is a partial unique index (see Review follow-up).
- Provider failure/timeout/malformed/unsafe output => `held`, claim COMPLETES (SMS) — it used to 5xx-retry (SMS) or
  fail-open "treat as inquiry" (email). A thrown (unexpected) classifier error still meters + fails the claim.
- Model never receives phone/email/links/ids/headers/display name/From; email `phone` is extracted in code.
- Drafts: recipient is always the verified sender (code). Output policy forbids contact details, placeholders, booking /
  consent claims, and price/percent/free claims not stated in the shop knowledge.
- Prompts changed minimally (untrusted-data fence + no-contact rule). LIVE EVALS NOT RUN (forbidden here) — a human
  must run `npm run eval` before provider activation. `eval/classification.eval.test.ts` updated for the new result shape.

## Files

New: `src/lib/provider-boundary/{text,redact,preflight,output-policy,log,run,hold,index}.ts`
Changed: `src/lib/{sms,email}-{classifier,drafter}.ts`, `src/app/api/twilio/sms/route.ts`,
`src/app/api/aurinko/webhook/route.ts`, `eval/webhooks.test.ts`, `eval/classification.eval.test.ts`,
`eval/integration/{twilio-inbound-replay,delivery-lifecycle-acceptance}.int.test.ts` (mock shapes only; NOT run —
no disposable DB stack here).

## Review follow-up (PR #148): hold marker race

- Reproduced first on the disposable stack (`gradia-isolated-tests`, :56531): 24 simultaneous `recordBoundaryHold`
  calls wrote 22 markers (SELECT-then-INSERT). The same test also showed the old lookup matched ANY system row with the
  same key text, so an unrelated note could suppress a real marker.
- Fix: migration `20261116120000_provider_boundary_hold_unique.sql` (next free version after main's
  `20261115130000`): partial unique index `interactions_provider_boundary_hold_unique` on
  `(shop_id, channel, (metadata->>'boundary_hold_key'))` for marker rows only; it first removes later duplicate
  markers (oldest kept; markers existed only on this unmerged branch). `hold.ts` is now one atomic INSERT; `23505` =>
  `{ok:true, recorded:false}`, other errors => `{ok:false}`. No new table/column/grant/policy; RLS, cascades and
  service writers unchanged.
- Evidence: `eval/integration/provider-boundary-hold.int.test.ts` (6; race, replay, per-stage/channel/shop isolation,
  mixed customer attribution, same-text non-markers untouched, RLS + customer/shop cascade) failed 3/6 before the
  migration and passes 3x after; `python3 -I scripts/verify-provider-boundary-hold-migration.py` (upgrade probe in one
  rolled-back transaction: dedupe, index shape, 23505, scoping, cascade, RLS/grants/columns/triggers unchanged; only
  runs on a stack still at the previous migration); from-zero `node scripts/test-stack.mjs reset` applied all 124
  migrations; `twilio-inbound-replay` (18) and `delivery-lifecycle-acceptance` (5) pass.
- Unit/route tests rewritten for the single-insert shape (`23505` => recorded:false, other codes => ok:false, no
  SELECT). origin/main merged in (7 commits, no conflicts). Not done: Aurinko provider-event replay claim, billing,
  voice, live evals, deploy, merge.

## Setup note

`node_modules` is a symlink to `../claude-commercial-billing-settlement/node_modules` (identical package-lock; gitignored).
`eval/agent-builder-navigation.test.tsx` fails to type/run without `@testing-library/*` (pre-existing, unrelated).

## Last checks (2026-11-16, Node 24.15.0, borrowed node_modules)

- `node scripts/isolated-check.mjs lint`: exit 0
- `node scripts/isolated-check.mjs unit`: 181 files, 2,846 passed / 4 skipped. One runner "error": `jsdom` missing for
  `eval/agent-builder-navigation.test.tsx` (borrowed node_modules; pre-existing, not touched here)
- `node scripts/isolated-check.mjs build` (offline, webpack): exit 0
- `node scripts/isolated-check.mjs types`: only the two `@testing-library/*` errors in `agent-builder-navigation.test.tsx`
- New suites: provider-boundary 124 + routes 50 pass; `eval/webhooks.test.ts` 93 pass
- Mutation check: no-op preflight => 83 new tests fail; no-op output text policy => 16 fail
- Integration files now run (see Review follow-up). NOT run: live evals

## Uncommitted paths

none

## Remaining for a human

- Review/merge decision (not merged here). Run `npm run eval` (live) before any provider activation: prompts changed.
- CI `integration` job runs the two touched integration files on its own stack.
- Follow-ups: held-message review surface; Aurinko replay claim; migrate remaining drafters/call sites to `runBoundaryTask`.

## Exact resume command

```
cd /Users/harryhatch/Gradia/worktrees/claude-provider-boundary-sms-email && git status -sb && git log --oneline -5 && sed -n 1,200p docs/handoffs/PROVIDER_BOUNDARY_V1_RESUME.md
```
