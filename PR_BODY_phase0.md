# Refreshed MVP — Gradia Agent, safe-send, credits/paywall, and the FOCUS NOW queue

Merges `mvp/phase-0-subtraction` into `main`. This is the full refreshed-MVP branch
(59 commits, ~266 files) culminating in the `GRADIA_FOCUS_AND_UI_BUILD_SPEC` NOW
queue (NOW-0 → NOW-4), plus the NEXT-3 Customer Recovery feature (built, but
**flag-gated OFF** and not yet live-smoked — see below).

## What's in it

**The Gradia Agent (the flagship).**
- One read+act conversational box (`owner-agent.ts`) with a bounded loop: read tools +
  a `stage_action` tool, **no `send` tool** — it stages outbound, never sends.
- Capability ladder L1–L6: action registry, cold-lead diagnostic, structured
  vehicle/last-visit segments, cross-model draft verification (Sonnet), routing/grounding
  evals, earned-autonomy graduation.
- **NOW-2:** Whisper routes the transcript through the *same* engine (one engine, two
  modalities). Capture executes immediately; outbound stages; booking/money always HITL.

**Trust + proof.**
- **NOW-3:** weekly ROI receipt — honest, traceable compute (money "in play," never
  "earned"), pinned to Home + a weekly SMS push (A2P-gated).
- Safe-send guardrails (B2): quiet hours, opt-out, marketing consent, BYO A2P gate.

**Owner UX (NOW-1 + NOW-4).**
- Subtraction: analytics/builder surfaces flag-gated (reversible).
- Command bar (⌘K + mobile tap-to-talk), three-page nav, optimistic approvals,
  Home receipt → nudges → live feed stack.

**Plumbing.** Credits + paywall, telephony/voice-builder, CRM (Jobber + Housecall Pro),
IG/FB + charge-customer removal (DB kept dormant).

## NEXT-3 Customer Recovery — included but OFF
Import inbox/contacts → extract past customers → review/approve → TCPA-gated
win-back, with a do-not-contact toggle + raw-upload retention cron. **Gated
behind `FEATURES.customerRecovery = false`** (routes 404, `/recovery` redirects,
entry link hidden), so it is inert in production. Pure + integration logic is
test-covered (locked TCPA gate, dedupe, parsers, retention); the DB + storage +
live-extraction glue has **not** been run end-to-end. **Do a live smoke on a
seeded shop before flipping the flag.**

## ⚠️ Migrations (15 new)
This branch adds 15 Supabase migrations (credits/billing, telephony pricing, A2P,
rate limits, structured segments, safe-send, approval resolution, vehicle color,
the two customer-recovery migrations + the `recovery-imports` storage bucket, …).
**`main` = production**, so these must be applied to the production DB as part of the
merge/deploy. Review `supabase/migrations/` before promoting.

## Locked-principle compliance
- Money + calendar writes stay `ALWAYS_HITL`; the loop has no send tool — both
  source-scan-locked in `eval/guardrails.test.ts` (incl. the voice path).
- Guardrails in code, not prompts. Workflows-by-default. Per-step model routing.
- Evals gate model/prompt/recipe changes.

## Verification
- `npm test` — 178 pure tests green (4 skipped).
- Live evals (`EVAL_LIVE=1`) — owner-agent routing/grounding 6/6 on Sonnet.
- `tsc` clean · eslint clean · `npm run build` green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
