# Twilio SMS Go-Live Checklist

Code side is done — inbound webhook, signature verification, SMS
classifier, HITL plumbing, and settings UI all live in the repo.
This is what you need to set up on Twilio's side and in env vars.

Scope is **inbound only**. Outbound SMS (HITL-gated `send_sms` action
type for nurture and replies) is its own follow-up task.

---

## 0. Prerequisites

- [ ] Migration `20260512120000_shop_twilio.sql` applied to remote
      Supabase (`supabase db push` or paste in the dashboard).
- [ ] Latest code deployed to Vercel.

---

## 1. Create / pick the Twilio account

Two supported modes:

**Pilot mode (global account)** — one Twilio account owns numbers for
multiple shops; only the env-level `TWILIO_ACCOUNT_SID` /
`TWILIO_AUTH_TOKEN` are stored. Each shop just configures the number
they own on that account. Quickest path to first pilot.

**BYO mode (per-shop credentials)** — each shop plugs in their own
Twilio account SID + auth token via `/settings#sms`. Encrypted at
rest with `ENCRYPTION_KEY`. Send + signature verification + status
callbacks all auto-detect BYO creds and use them when present;
otherwise they fall back to the env globals. This is the model for
scale: independent A2P 10DLC registrations, independent
deliverability reputation, the shop owns their own Twilio bill.

Outbound sends in BYO mode pass `?shop=<id>` on the status callback
URL so the status route can pick the right auth token to verify
delivery callbacks against.

1. Sign up at <https://www.twilio.com/console> if needed.
2. Note the **Account SID** and **Auth Token** from the console
   homepage. These are the global credentials (or the BYO shop's
   credentials, depending on mode).

---

## 2. Set Vercel env vars

In Vercel → Project → Settings → Environment Variables:

```
TWILIO_ACCOUNT_SID=AC...           # from Twilio console homepage
TWILIO_AUTH_TOKEN=...              # from Twilio console homepage
```

Drop the same two into `.env.local` for local dev. **Redeploy** after
saving — Vercel doesn't pick up env changes until next deploy.

---

## 3. Buy / pick a phone number

In the Twilio console → **Phone Numbers → Buy a Number**. Pick one
in the shop's area code with **SMS capability**. Twilio's standard
US numbers are about $1.15/mo + per-message fees.

---

## 4. Point the number's webhook at Gradia

In Twilio console → **Phone Numbers → Manage → Active Numbers**, open
the number you just bought. Scroll to **Messaging Configuration →
A message comes in**:

- **Webhook:** `https://gradia-ai-platform.vercel.app/api/twilio/sms`
  (use your actual Vercel URL — the `/settings` page shows the exact
  URL for the current environment)
- **HTTP method:** `HTTP POST`

Leave fallback URL empty. Save.

---

## 5. Connect the number in Gradia

1. Visit `/settings`.
2. Under **SMS receptionist**, paste the number in **E.164 format**
   (e.g. `+15551234567`).
3. Click **Save** — you should see a green **Connected** pill.

The settings page surfaces a warning if `TWILIO_ACCOUNT_SID` /
`TWILIO_AUTH_TOKEN` aren't set on the server yet.

---

## 6. Smoke test

Text the Twilio number from your personal phone with a real-feeling
inquiry. Something like:

> *Hey, do you do ceramic coating on a Tesla Model Y? Looking to book
> next weekend if possible.*

Expected:
1. Twilio POSTs to `/api/twilio/sms` within a second or two.
2. The handler verifies the `X-Twilio-Signature`, resolves the shop
   by the `To` number, dedups the customer by phone (channel = `sms`),
   and records the interaction in the shared memory layer.
3. The Claude classifier marks it as a lead (it's an obvious new
   inquiry, not a one-word follow-up).
4. A `pending_action` (`create_lead`, `source: "sms"`) is inserted
   with the customer phone, an extracted vehicle + service, and a
   one-line summary.
5. A Slack approval card lands. Approving from Slack (or the
   `/approvals` editor) lands the lead in `/leads`.

Then send a one-word follow-up like *"thanks"* or *"yes"* from the
same number. Expected: it lands in `interactions` (channel = `sms`)
but does **not** generate a new approval card — the classifier is
tuned to recognize short follow-ups as not-leads.

---

## 7. Common gotchas

| Symptom | Cause |
|---|---|
| Webhook returns **401 Invalid signature** | `TWILIO_AUTH_TOKEN` mismatch between Twilio and Vercel, or the public URL Twilio called isn't being reconstructed correctly. Make sure the webhook URL in the Twilio console matches the one shown in `/settings` (including the path). |
| Webhook returns **200 but nothing in approvals** | Either: the `To` number doesn't match any shop's `twilio_phone_number` (check `/settings` shows it Connected), or the classifier marked it as not-a-lead. Check Vercel logs. |
| Every short reply generates a new approval card | Classifier prompt isn't catching the follow-up case. Tighten the `is_lead = false` rules in `src/lib/sms-classifier.ts`. |
| Image MMS messages | Pilot scope ignores `MediaUrl0…` — body-only. Media handling is a follow-up if it matters. |
| Phone number won't save (`unique violation`) | Another shop in this Supabase project already claimed that number. Should be impossible in single-shop pilot mode — check the `shops` table directly. |

---

## 8. Known limitations (pilot scope)

- **No auto-reply.** Twilio webhook responses are always empty TwiML.
  Every outbound message has to go through HITL (per OPERATIONS.md).
  Outbound SMS — both operator-initiated replies and AI-proposed
  nurture — is its own task.
- **One number per shop.** If a shop needs multiple numbers (e.g.,
  separate marketing and ops lines), we'd need to either let them
  paste a list or move to a Messaging Service. Not a real need yet.
- **No STOP / HELP compliance UI.** Twilio handles STOP / HELP at the
  carrier level by default — we don't override. Long-term we'd want
  to surface opt-out status on the customer record.
- **No status callbacks.** We only listen for inbound messages.
  Delivery receipts for outbound (once outbound ships) will need a
  second webhook.

---

## 9. After go-live

Next on the engineering side:

1. **Outbound SMS via HITL** — new `send_sms` action type, Slack card
   variant, "Reply" UI on `/approvals/[id]` and the (future)
   `/customers` view.
2. **Google Calendar** + `book_appointment` — turn proposed bookings
   into real calendar slots.
3. **Stripe** — Whisper "charge Smith $450" demo.
