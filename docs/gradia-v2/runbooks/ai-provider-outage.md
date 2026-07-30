# Runbook — AI Provider Outage (Anthropic / OpenAI)

_Created 2026-07-25 by the Organizer. Anthropic powers all classification/drafting/planning/agent loops; OpenAI powers embeddings, Whisper transcription, and (inside Vapi) the voice LLM. Design intent (D-002 direction): **the CRM keeps working with AI down** — approvals, customers, calendar, quotes are non-AI paths. The dangerous part is a known polarity bug: on classifier failure, **SMS skips (safe) but email defaults to "is a lead"** (`aurinko/webhook/route.ts:212`) — an Anthropic outage floods `/approvals` with a card for every inbound newsletter._

## Trigger / symptoms
- Agent chat/BI/Whisper returning errors (raw vendor errors surface to users — no friendly wrapper on most calls).
- Approval inbox flooding with low-quality "lead" cards from email (the polarity bug signature).
- Campaign runs completing with high `draft_failed` counts — transient LLM errors **silently drop recipients** (`.catch(() => null)` in draft loops); an outage mid-run looks like a small audience, not an error.
- Embeddings failures: memory rows still write (embed is best-effort) but semantic recall quietly degrades; knowledge search fails to `[]` so drafts lose grounding without erroring.

## Severity
- Full Anthropic outage: **SEV-2** (product degrades to manual CRM; nothing corrupts; HITL means nothing wrong is *sent*).
- Escalate to **SEV-1** if: autopilot/automations were mid-run (recipients silently dropped = broken follow-up promises), or the email card flood is burying real approvals.

## Immediate containment
1. **Email flood:** stop the source — disable the Aurinko webhook at the provider console, or flip the email-channel flag in `features.ts` + redeploy. Tell the owner to bulk-Dismiss junk cards; real emails still sit in their mailbox (Gradia is not the mail store — nothing is lost).
2. **Pause scheduled agent work** so runs don't fire into a failing provider and burn their audiences: disable autopilot automations / rotate `CRON_SECRET` to hold sweeps (note the collateral: reminders, reconciliation pause too).
3. Voice: unaffected by Anthropic (Vapi-side `gpt-4o-mini`); an **OpenAI** outage degrades voice + Whisper transcription + embeddings instead — same containment shape, different features.
4. Do not swap model ids ad hoc — there is no LLM seam yet (ids hardcoded in ~14 modules) and no fallback chain; a panicked multi-file model swap during an outage is how regressions ship (see risk R-12). Wait it out; the manual CRM works.

## Diagnosis
- Anthropic/OpenAI status pages; Sentry error rates on `ai-service.ts` callers; Vercel logs for 429/5xx patterns (only `ai-service.ts` and `embeddings.ts` retry — planner/loops/drafters fail fast).
- For each automation run in the window: `custom_agent_runs` records the fire + skip stats — reconstruct dropped recipients from there.

## Recovery
- Re-enable webhooks/flags/crons in reverse order.
- **Re-run dropped follow-ups deliberately:** cooldown logic will *block* re-contact of customers who were successfully messaged, which is exactly right — re-run targets only the dropped remainder. Verify with a dry-run preview before executing.
- Backfill embeddings for interactions written during an OpenAI outage — REQUIRES VERIFICATION that a backfill path exists; if not, note the permanent recall gap for that window (or ticket a backfill script).

## Verification
- One classification, one draft, one BI answer, one Whisper note succeed; email classifier verified on a harmless test email before re-enabling the webhook.
- No customer received a duplicate from the re-run (spot-check `interactions`).

## Communication
- In-app honesty if owners noticed ("drafting was down; nothing was sent incorrectly; follow-ups resumed"). HITL is the reassuring fact — lead with it.

## Postmortem
- This runbook firing is standing evidence for three backlog items: the polarity fix (E07), LLM seam + retries/timeouts (P1), and alerting (P0-012 — an outage should page, not surprise). Update risks R-12/R-13.

## Known gaps
- Failure polarity inversion on email (known bug, E07).
- Silent recipient drops in draft loops; no retry on planner/loops/drafters; no request timeouts (hung fetch rides to Vercel's 60s kill).
- No model fallback chain, no LLM seam — by design until P1; this runbook accepts "wait" as the strategy.
