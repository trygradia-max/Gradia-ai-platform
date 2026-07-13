# Founder-Ops Runbook — the items only you can execute
*2026-07-08. Launch: August 7, 2026. Companion to GO_LIVE_CHECKLIST.md (reconciled same day — read its STATUS banner first). Everything here needs your accounts (GitHub / Supabase / Vercel / Twilio) — agents have prepped around these but cannot do them.*

Work top to bottom. Estimated total hands-on time: ~3–4 hours spread over a week (carrier approval has a 1–3 day wait in the middle).

## 1. Git (30 min) — this week
1. Commit the untracked docs + today's fixes on `redesign/glass-box`:
   `platform/_docs/redesign/KEY-ROTATION-RUNBOOK.md`, `platform/_docs/redesign/SECURITY-AUDIT.md`, plus today's changes (`eval/_setup.ts` quote-stripping, `eval/roi-receipt.test.ts` fixture fix, `GO_LIVE_CHECKLIST.md` reconcile, this file, C1 migration).
2. `git merge main` into `redesign/glass-box` (only the PR-#1 merge commit; should be clean).
3. Open PR `redesign/glass-box → main`, skim the 12-commit diff, merge. **Do not** re-merge phase-0 — it's already in main.

## 2. Prod database (30 min)
1. Apply the migration set in filename order — now **19**: the checklist's 16 + `20260618130000_crm_specialist_metrics` + `20260702120000_glass_box_capture` + `20260708120000_crm_foundation_c1` (new, additive — see `_docs/GRADIA_CRM_FOUNDATION_SPEC.md`).
2. Verify the `recovery-imports` bucket exists and is **private** (checklist §1).
3. Spot-check columns per checklist §1, plus new C1 tables: `vehicles`, `quotes`, `automations`.

## 3. Env keys in Vercel (20 min)
Per checklist §2. Two that bite:
- **`ENCRYPTION_KEY`** — generate a fresh one for prod (`openssl rand -hex 32`). Was missing from the original checklist entirely; your dev `.env.local` had an empty placeholder until 2026-07-08 (now fixed with a dev-only key — never reuse it in prod).
- **`CRON_SECRET`** — all 7 crons fail closed without it.
Also confirm the rotated `OPENAI_API_KEY` is the prod value, and set `TWILIO_PRIMARY_PROFILE_SID` + vendor keys (telephony spec status line).

## 4. Deploy + crons (10 min)
Merge → deploy; confirm 7 crons registered in Vercel (checklist §3).

## 5. Telephony live spikes (30 min) — needs real Twilio/Vapi keys
`scripts/spike-*.mjs` per GRADIA_TELEPHONY_VOICE_BUILDER_SPEC.md status line, incl. the voice/SMS webhook-split spike. Start A2P on your test shop's number **early** — carrier approval is the 1–3 day wait.

## 6. Smoke tests (1–2 hrs) — checklist §4, in order
Whisper router → ROI receipt → command bar/mobile loop → review requests → no-show ladder → CRM seam → **Customer Recovery last, on staging** (the only never-run pipeline). Flip flags per §5 only after each smoke passes.

## 7. Owner acceptance run (30 min, on your phone)
The 10-minute telephony acceptance + checklist NOW-4 mobile loop (<60s lead→approve→receipt). If these pass, you're launch-ready — everything after is polish.

## Not yours (agents handle)
CRM C1 code phase (vehicle callers, pricing module, seeds — per the C1 spec status), remaining test/lint upkeep, docs. HCP `TODO(verify)` items need a sandbox account + partner app — decide if HCP matters for alpha; if not, defer (Jobber is live).
