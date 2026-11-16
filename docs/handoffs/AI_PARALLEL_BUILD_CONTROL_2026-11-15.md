# Gradia parallel AI build control

_Coordinator snapshot: 2026-11-15 Pacific. This is an operational handoff, not a
production authorization. Read `AGENTS.md`, `docs/AI_WORK_LOG.md`, and the five
governing documents before continuing any lane._

## Rules for every lane

1. Work only in the named worktree and branch; fetch and rebase on current
   `origin/main` before the final push.
2. Never use live Stripe, Twilio, Vapi, Meta, shared Supabase, production Vercel,
   production secrets or customer data unless the founder separately authorizes
   that exact operation.
3. Keep provider calls mocked and use disposable local stacks for database proof.
4. Maintain the lane handoff file before large edits. At each coherent milestone:
   run targeted validation, update the handoff, commit, and push.
5. If Claude Max usage is exhausted, do not improvise or restart elsewhere. Commit
   and push the coherent state, record the last passing checks, exact next command,
   open questions and uncommitted paths, then stop. Resume the same session after
   the allowance resets.
6. Open a non-draft PR only after the bounded scope is complete. Do not merge from
   a Claude session; Codex reviews the diff and fresh CI first.

## Active lanes

### Commercial Billing PR D

- Worktree: `/Users/harryhatch/Gradia/worktrees/claude-commercial-billing-settlement`
- Branch: `claude/commercial-billing-settlement`
- Claude session: `4ae4cae9-2e4f-4cad-bd98-792c89405978`
- Resume: `claude --resume 4ae4cae9-2e4f-4cad-bd98-792c89405978`
- Checkpoint: `docs/handoffs/COMMERCIAL_BILLING_PR_D_RESUME.md`
- Scope: reviewed Stripe metric/event mapping and deterministic, replay-safe
  closed-period settlement/invoice preview from the existing usage and membership
  ledgers.
- Excludes: live Stripe, webhooks, dunning, refunds, Customer Portal, deploy and
  production changes.
- Follow-on: PR E signed webhook/subscription reconciliation plus dunning,
  cancellation, refunds and portal; PR F test clocks, caps and full sandbox
  acceptance.

### Remaining protected voice columns

- Worktree: `/Users/harryhatch/Gradia/worktrees/claude-security-voice-columns`
- Branch: `claude/security-fix-remaining-voice-columns`
- Claude session: `b334aad6-1eac-4f9a-ad02-33462d263b8f`
- Resume: `claude --resume b334aad6-1eac-4f9a-ad02-33462d263b8f`
- Checkpoint: the session must create and maintain its resume handoff before broad
  edits; inspect the worktree for the exact path before resuming.
- Scope: reproduce and close authenticated-owner forging of remaining
  server-controlled voice provider identity and launch-state fields while
  preserving legitimate server writers.
- Excludes: A2P registration, commercial billing, live voice/provider calls,
  deploy and production changes.
- Follow-on: a separate narrow provider-boundary prompt-injection and PII
  minimization contract.

## Completed security lane awaiting or after review

### A2P registration state

- PR: #144
- Commit: `dc919c46c58574e6ee267c5b449055938a5a2ecb`
- Result: merged to `main` as `1ce68de4fabd6932e59b1c2d9ac3958f1479aa51`.
- Evidence: the authenticated-owner INSERT/UPDATE/DELETE exploit was reproduced
  before the migration and refused afterward; full CI passed.
- Production status: migration is merged but not thereby applied to production.

## Marketing handoff

- Master: `docs/marketing/GRADIA_GTM_SALES_MASTER.md`
- Position: the agentic operating system for detailing businesses.
- Lead problem: owner-led shops lose speed, consistency and visibility between an
  inquiry and booked, completed work.
- Claim discipline: market reviewable, approval-first operations; distinguish
  merged, gated, in-progress and future capabilities; do not publish invented ROI,
  compliance or customer-result claims.

## Coordinator review order

1. Review and merge security PRs only after fresh CI and real exploit/negative
   controls pass.
2. Review Commercial Billing PR D before starting PR E.
3. Rebase each surviving branch after every merged migration to preserve migration
   order and final-tree integration evidence.
4. After PR D and the voice-column fix: run the next security provider-boundary
   slice and Commercial Billing PR E in parallel.
5. Complete PR F sandbox acceptance, signed-in hosted product acceptance and the
   exact-candidate production release packet before any broad launch.

## Useful status commands

```sh
claude agents --json
gh pr list --state open
git -C /Users/harryhatch/Gradia/platform fetch origin main
```

Do not delete a worktree until its branch is merged and every handoff or evidence
file needed for the next lane exists on `main`.
