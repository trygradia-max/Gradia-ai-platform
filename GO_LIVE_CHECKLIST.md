# Gradia — Go-Live Checklist (redesign/glass-box → production)

_Generated 2026-06-18; **reconciled 2026-07-08** against the actual branch state. Launch is now **August 7, 2026** (pushed from July 10)._

> **STATUS 2026-07-08 — read this first, the doc below was written for an older world:**
> - **§0 "Merge the PR" is DONE.** PR #1 (`mvp/phase-0-subtraction`) merged to `main` (`edfea35`). Do not redo it.
> - **The branch to ship is now `redesign/glass-box`** — 12 commits ahead of `main`: 2 phase-0 leftovers (CRM Specialist schema + recovery UI polish) + the full glass-box redesign (retheme, 6-destination IA with redirects, Activity feed, call-record page). `main` has nothing `glass-box` lacks except the PR-#1 merge commit itself — merge `main` into `glass-box` first (trivial), then open **PR: `redesign/glass-box` → `main`**.
> - **Migration list below is short by 2.** The branch adds `20260618130000_crm_specialist_metrics` and `20260702120000_glass_box_capture` — **18 total**, still all additive.
> - `ENCRYPTION_KEY` was missing from §2 (added below). Dev `.env.local` had an empty placeholder — fixed 2026-07-08; **prod needs its own key**.
> - Suite state on `glass-box` as of 2026-07-08: **282/282 tests pass, lint clean** (verified).

Work top to bottom; nothing user-facing flips on until its smoke test passes. Several features are intentionally **flag-gated off** until smoked.

---

## 0. Before you merge

- [ ] Open the PR: https://github.com/trygradia-max/Gradia-ai-platform/compare/main...mvp/phase-0-subtraction?expand=1 — body in `platform/PR_BODY_phase0.md` (install `gh` to let the agent open it, or click through).
- [ ] Skim the diff. It's large (~59+ commits) and includes NEXT-3 (Customer Recovery) which is **gated off + not live-smoked**.
- [ ] Confirm a coworker's `ci: quarantine + harden ci-integration` commit (`5ee85b3`, top of branch) is expected — not authored in this work.

---

## 1. Apply migrations (production DB)

All 16 are additive (new tables/columns/bucket); none drop or rewrite existing data. Apply in filename order:

```
20260601100000_credits_billing            20260615130000_structured_segments
20260609100000_shop_plan_default_free     20260615140000_safe_send
20260609110000_telephony_pricing_metering 20260615150000_approval_resolution
20260609120000_a2p_registrations          20260615160000_vehicle_color
20260611100000_voice_builder              20260616120000_customer_recovery   ← NEXT-3 tables/cols
20260611110000_pricing_skus               20260616130000_recovery_storage    ← NEXT-3 bucket
20260611120000_reschedule_cancel_actions  20260618120000_appointment_confirm ← NEXT-2 cols
20260614120000_shop_housecallpro
20260615120000_rate_limits
```

- [ ] Run the migration set against prod.
- [ ] **Verify the storage bucket landed:** `20260616130000_recovery_storage` does `insert into storage.buckets ('recovery-imports', private)`. Confirm the bucket exists and is **private** (Supabase → Storage). If your migration runner can't write `storage.buckets`, create the bucket manually: name `recovery-imports`, **not public**.
- [ ] Spot-check new columns exist: `appointments.confirmed_at`, `appointments.confirm_pending_action_id`; `customers.source / last_transaction_at / do_not_contact`; tables `import_jobs`, `import_messages`.

---

## 2. Env / config (verify present in prod)

- [ ] `ENCRYPTION_KEY` — **64 hex chars (`openssl rand -hex 32`)**; encrypts Twilio subaccount tokens at rest. Generate a **separate** key for prod (never reuse the dev key). Without it, number purchase fails closed. *(Added 2026-07-08 — was missing from this list; dev `.env.local` had an empty placeholder, now fixed.)*
- [ ] `ANTHROPIC_API_KEY` — all drafting/extraction.
- [ ] `OPENAI_API_KEY` — **Whisper transcription** (NOW-0 rotated this; confirm the prod value is the rotated one).
- [ ] `CRON_SECRET` — every cron fails closed without it. All 7 crons need it.
- [ ] `STRIPE_SECRET_KEY` / `STRIPE_PRICE_ID` / `STRIPE_WEBHOOK_SECRET` — paywall (already live).
- [ ] Jobber + Housecall Pro OAuth client id/secret — only if you'll smoke the CRM seam end-to-end.
- [ ] Twilio / Aurinko / Vapi — already configured (app runs today).

---

## 3. Deploy

- [ ] Merge → deploy. **Crons auto-register from `vercel.json`** — no manual step. New ones: `/api/cron/roi-receipt` (Mon 16:00 UTC), `/api/cron/recovery-retention` (daily 04:00), `/api/cron/no-show-ladder` (hourly :15).
- [ ] Confirm the 7 crons show up in the Vercel dashboard after deploy.

---

## 4. Smoke tests (per feature — do BEFORE flipping any gated flag)

These run with the flags at their **current** state (recovery OFF, no-show ladder ON).

### NOW-2 — Whisper-as-router  _(flag: whisper=on)_
- [ ] On a seeded shop, tap-to-talk: **"Log a walk-in: Jane, silver Tesla"** → a lead is created immediately, no approval, toast reads back what it did.
- [ ] **"Text Marcus his quote"** → a draft lands in `/approvals` (nothing sent).
- [ ] **"Sort by lifetime value"** → honest refusal (no fake plan).

### NOW-3 — ROI receipt  _(always on)_
- [ ] Home shows the receipt pinned on top; at zero it shows the written empty state.
- [ ] With seeded data, the money figure ties to real booked-service rows (spot-check one).
- [ ] (Optional) trigger `/api/cron/roi-receipt` manually with the `Authorization: Bearer $CRON_SECRET` header → owner gets the weekly SMS (only A2P-cleared/BYO-verified shops).

### NOW-4 — Command bar / mobile loop  _(always on)_
- [ ] **On a phone:** capture a lead by voice → approve a staged text → read the receipt, all in <60s. No vendor/tech strings visible.
- [ ] ⌘K opens the command bar on desktop; approvals slide out optimistically.

### NEXT-1 — Review requests  _(drafter on; auto-recipe needs workflowBuilder)_
- [ ] Settings → Reviews: paste a Google/Yelp review URL, save.
- [ ] In the box: **"send Marcus a review request"** → staged copy in `/approvals` **contains the review link** and reads as a neutral ask (not "if you were happy…").

### NEXT-2 — No-show ladder  _(flag: noShowLadder=ON)_
- [ ] Seed an appointment ~40h out → run `/api/cron/no-show-ladder` (with CRON_SECRET) → a **confirm-by-text** stages in `/approvals` ("Reply YES…").
- [ ] Simulate the customer texting **"YES"** to the shop number → `appointments.confirmed_at` is set; the at-risk nudge does not appear.
- [ ] Seed an unconfirmed appointment <12h out → Home shows the amber **"hasn't confirmed — nudge or backfill"** co-owner nudge.

### NEXT-4 — CRM seam  _(on if a CRM is connected)_
- [ ] With **no** CRM connected: approve a recovered customer → no error (seam no-ops). _(This also runs as part of the NEXT-3 smoke below.)_
- [ ] (If smoking CRM) Connect Jobber or Housecall Pro in Settings → approve a lead → confirm the client appears in that CRM and the id mirrors back.

### NEXT-3 — Customer Recovery  _(flag: customerRecovery=OFF — smoke LAST, then flip)_
This is the **only pipeline never run end-to-end.** Do it on a seeded/test shop.
- [ ] Temporarily set `FEATURES.customerRecovery = true` in a **preview/staging** deploy (not prod yet).
- [ ] Go to `/recovery` → upload a small `.mbox` (or a contacts `.csv`/`.vcf`) → confirm: parse → **estimate ("~N credits")** shows → confirm → extraction runs → **review queue** groups candidates (ready / possible dup / needs a look).
- [ ] Bulk-approve → customers land in `/customers` with `source=import`; a timeline note is recorded; (if a CRM is connected) they push through the seam.
- [ ] Verify the **TCPA gate**: a customer with a >18-month last-transaction can never be SMS-targeted by a recovered_customers win-back (email only).
- [ ] Verify **retention**: after extraction the raw bodies are purged from `recovery-imports` (or run `/api/cron/recovery-retention`).
- [ ] Verify **do_not_contact**: toggle it on a customer file → they drop out of any staged outreach.

---

## 5. Flip the gated flags (only after the matching smoke passes)

In `src/lib/features.ts`, then redeploy:

- [ ] **`customerRecovery: true`** — only after the full NEXT-3 smoke (§4) passes on staging. This un-404s `/api/recovery/*`, the `/recovery` page, and the Customers entry link.
- [ ] _(Optional)_ **`workflowBuilder: true`** — if you want owners to self-build scheduled/event agents (incl. the auto post-job **review_request** recipe and reminder/confirm agents). Currently off for alpha. The review/no-show machinery works without it; this just exposes the builder UI.
- [ ] `noShowLadder` is **already on** — flip to `false` only if the double-text (confirm + reminder) proves too much for pilots.

---

## 6. Marketing / claims (only after acceptance)

- [ ] `_docs/WHAT_GRADIA_DOES.md` — move **"The Reviewer"** and the **Customer Recovery** pitch from "not yet claimable" to the claim list **only after** their smokes pass. Don't promise either until live.
- [ ] Marketing site does **not** auto-deploy on merge — trigger the Vercel deploy explicitly if copy changes.

---

## 7. Rollback notes

- Every new feature is **flag-gated or HITL-staged** — nothing auto-sends or auto-writes without approval. To disable a feature, flip its flag and redeploy (gate, don't delete).
- Migrations are additive; a rollback of code doesn't require a DB rollback.
- The `recovery-imports` bucket holds raw PII; the retention cron purges it, but if you abort the rollout, empty/remove the bucket.

---

### Quick status snapshot
| Area | State on deploy |
|---|---|
| Whisper / ROI receipt / command bar / no-show ladder | **ON** |
| Review-request drafter + settings | **ON** (auto-recipe needs workflowBuilder) |
| CRM seam | **ON** (no-ops without a connected CRM) |
| Customer Recovery (`/recovery`, import routes) | **OFF** until §4 smoke passes |
| Self-serve agent builder (`workflowBuilder`) | **OFF** (optional) |
