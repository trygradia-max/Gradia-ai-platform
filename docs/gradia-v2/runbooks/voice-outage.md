# Runbook — Voice Outage

_Created 2026-07-25 by the Organizer. The voice receptionist is Vapi-hosted (telephony/STT/LLM/TTS on `gpt-4o-mini`), bridged by `/api/vapi/webhook`. Designed fallbacks already exist: at 100% voice budget the assistant is PATCHed to a **take-a-message fallback** (`vapi_stale` → hourly voice-sync cron), and the standing invariant is **never cut a live call** — state changes apply from the next call._

## Trigger / symptoms
- Owners report calls ringing out, dead air, or the assistant answering wrong/stale (stale synthesized prompt).
- `call_records` stop appearing for shops with active numbers; Vapi dashboard shows failures.
- Tool calls failing: Vercel logs on `/api/vapi/webhook` (per-shop `x-vapi-secret` verification failures would also present as "assistant answers but can't do anything").
- Misroute variant: an unmatched assistant landing on the `VAPI_DEFAULT_SHOP_ID` fallback shop — **that is a tenant incident, switch to `tenant-data-leak.md`**. Since P0-007 (2026-08-14, PR #21) the production fallback **fails closed** — an unmatched assistant in prod gets HTTP 404 "Shop not configured" with zero writes, so in prod this presents as calls that "can't do anything" for a misconfigured assistant, not as misrouted data. If misrouted rows nonetheless appear in prod, the guard was bypassed — treat as its own defect. (Operational verification that the var is unset in prod remains P0-010.)

## Severity
- Provider-wide Vapi outage: **SEV-1** — missed calls are the exact loss the product exists to prevent, and Package-2 owners pay for this capability.
- Single-shop stale assistant / config drift: **SEV-2/3** (hourly voice-sync usually self-heals).

## Immediate containment
1. Confirm scope: Vapi status page; one shop vs all; Twilio console shows whether calls reach the number at all (Twilio problem vs Vapi problem — different vendors, different runbooks in spirit; number-level issues → Twilio console).
2. **Do nothing to live calls.** If behavior must change, change the assistant config — it applies next-call.
3. If Vapi is hard-down: calls fall to whatever the number's failure behavior is — **REQUIRES VERIFICATION** (voicemail? busy? this must be established in the telephony acceptance run and recorded here). Tell owners now, honestly: "calls to your Gradia number may not be answered; forward your line if urgent."
4. If the fault is our webhook (Vercel side): tool calls fail closed (staging nothing) — the assistant degrades to conversation-only. Fix the route; do not disable signature verification to "get it working."

## Diagnosis
- Vapi dashboard call logs vs `call_records` (idempotent upsert on `(shop_id, vapi_call_id)`) — gap analysis shows where the pipeline broke: call happened but no record = end-of-call report lost (no retry/queue on our side).
- `x-vapi-secret` mismatches after a shop edit → voice-sync repair state (`vapi_stale`).
- Budget lockout is *by design*: check the shop's minute meter before calling it an outage.

## Recovery
- Provider recovery: hourly voice-sync cron re-PATCHes stale assistants; force it early by invoking the cron route with `CRON_SECRET` if needed.
- Lost end-of-call reports: transcripts/metering for those calls are gone unless Vapi can re-deliver — **REQUIRES VERIFICATION** of Vapi redelivery behavior (audit open question #13). Since P0-007, a redelivery is safe to accept at any time: the report is replay-idempotent (one transcript set, one meter row, no matter how many deliveries; a redelivery after a mid-processing failure is retried/reclaimed rather than stranded). Note: the transcript resume is count-based and assumes a retry carries the same ordered final report (accepted P0-007 residual). Reconcile minutes from the Vapi dashboard; grant/meter compensation per `double-billing.md` discipline.
- Missed-call make-good: owner texts the callers back — `call_records`/Twilio logs give the numbers; draft outreach through the normal HITL path.

## Verification
- One live test call per affected shop tier: answered, tool call stages an approval, transcript lands in `interactions`, one meter row.
- `vapi_stale` flags cleared.

## Communication
- Package-2 owners are paying for answered calls: proactive notice during any SEV-1, with minute-credit make-good if metering was affected.

## Postmortem
- Update risk register; if the loss was end-of-call data, that strengthens the E10 queue/dead-letter case.

## Known gaps
- No dead-letter for lost Vapi reports; no health probe on the voice path (P0-012).
- Number-level failure behavior when Vapi is down: REQUIRES VERIFICATION (record the answer in this file when the telephony acceptance run happens).
- Voice quality/compliance depends on prompt-only enforcement until the post-call verifier (E09).
