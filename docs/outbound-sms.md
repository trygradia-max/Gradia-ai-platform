# Outbound SMS

Two paths land outbound text messages through the same Twilio number
that handles inbound:

1. **Operator-direct (no HITL)** — a logged-in user clicks **Send** in
   the Quick Reply card on `/approvals/[id]` for SMS-source pendings.
   Sends immediately because the human is right there.
2. **AI-initiated (HITL-gated)** — agents / cron jobs / future
   triggers stage a `send_sms` `pending_action` via
   `proposeOutboundSms`. The same Slack-approval card UX as every
   other Gradia action — Approve & send / Edit / Reject. On approval,
   the engine calls Twilio and records the outbound message in the
   shared memory layer.

---

## 0. Prerequisites

- [ ] Twilio inbound is already live (`docs/twilio-go-live.md`). The
      same `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` + the shop's
      `twilio_phone_number` are reused for sending.
- [ ] Migration `20260513100000_send_sms_action.sql` applied to the
      remote Supabase (`supabase db push` or paste in dashboard).
      Adds `send_sms` to the `pending_action_type` enum.
- [ ] Latest code deployed to Vercel.

---

## 1. Operator Quick Reply

On an SMS-source pending action page (`/approvals/[id]` for a
`create_lead` or `book_appointment` that came in over SMS), the
**Quick reply** card sits below the editor. Type a message, hit
**Send** — Twilio dispatches it, and the message lands in
`interactions` with `channel = sms`, `role = gradia`,
`metadata.direction = "outbound"`.

The card only shows up when:
- The pending action's `source` payload field is `"sms"`, and
- The shop has a `twilio_phone_number` connected in `/settings`.

If we ever take this somewhere else (customer detail view, lead
page), the same `<SmsQuickReply>` component drops in — both arguments
are just `toPhone` (E.164) and an optional `customerName`.

---

## 2. AI-initiated sends (HITL)

Any server-side code with a logged-in operator context can stage a
draft for approval:

```ts
import { proposeOutboundSms } from "@/app/actions/outbound-sms"

const result = await proposeOutboundSms({
  to_phone: "+15551234567",
  body: "Hey Sam — we've got you down for Saturday at 2pm. Any chance you can swing the truck by at noon to drop the keys?",
  customer_name: "Sam Rivera",
  reason: "Booking confirmation",
})
```

That posts an approval card to the shop's Slack channel with the
recipient, the draft, and the reason. The approver can:

- **Approve & send** — engine calls Twilio, records the outbound
  interaction, marks the pending action `approved` with the Twilio
  `MessageSid` as `result_id`.
- **Edit** — deep-links to `/approvals/{id}` where the SMS draft form
  takes over (To / Customer / Message / Reason). Save changes, then
  approve.
- **Reject** — drops it. Nothing sends.

**Triggers live:**
- **Inbound SMS auto-draft.** When the inbound classifier marks a
  message as a lead, `/api/twilio/sms` calls `draftSmsReply` (Claude
  Haiku 4.5, on-brand we/us voice, ~160 chars, signed as "— Gradia at
  {shop_name}", never quotes price or commits to a time), stages it
  as a `send_sms` pending, and posts the approval card. Operators see
  two cards per inbound lead: the lead approval, then the draft reply.
- **Booking confirmation.** When `executeBookAppointment` lands a
  booking, `draftBookingConfirmationSms` writes a short confirmation
  ("you're set for ceramic coating Sat 2pm — Gradia at Apex Detailing"),
  stages it as a `send_sms` pending tied to the customer, and posts
  the approval card. Skipped if the shop hasn't connected SMS or the
  lead has no phone.

- **24h appointment reminder.** A Vercel cron at `/api/cron/reminders`
  runs hourly. Each pass finds appointments scheduled 23–25h from now
  that don't yet have a `reminder_pending_action_id`, calls
  `draftAppointmentReminderSms`, stages a `send_sms` pending, posts
  the Slack approval card, and stamps the appointment row so the
  next pass skips it. Set `CRON_SECRET` in Vercel env — the route
  verifies it on every invocation.

Drafter or Slack failures on any trigger are best-effort — they never
block the underlying lead, booking, or appointment from landing.

Other triggers still pending: post-job review-request SMS, nurture
sequences, delivery-status callbacks.

---

## 3. Smoke test

### Operator-direct
1. Text the shop's Twilio number from your personal phone (creates an
   SMS-source pending action).
2. Open the approval card in Slack → click **Edit** → land on
   `/approvals/{id}`.
3. The **Quick reply** card appears below the editor with your number
   pre-filled. Type a message, **Send**.
4. Your phone receives the text. The outbound message also appears in
   the shop's `interactions` table (`role = gradia`,
   `metadata.direction = "outbound"`).

### AI-initiated
For now, easiest test is to call `proposeOutboundSms` from a server
context (a one-off API route, REPL, or temporary action button).
The approval card lands; approve and verify the SMS arrives.

---

## 4. Common gotchas

| Symptom | Cause |
|---|---|
| Approval rejects with **"Connect SMS in /settings before approving outbound messages."** | The shop's `twilio_phone_number` is null. Connect in `/settings → SMS receptionist`. |
| Twilio returns `21610` (unsubscribed recipient) | The recipient sent `STOP` to your number. Twilio enforces opt-out at the carrier level; we don't override. |
| Twilio returns `21408` (permission to send to area code) | New Twilio accounts have geographic permissions disabled by default. Enable the target country/region in Twilio console → Messaging → Geo permissions. |
| Operator Quick Reply card doesn't appear | The pending action's `source` isn't `"sms"`, or the shop's Twilio number isn't connected. Check the payload's `source` field in the `pending_actions` row. |
| Message length warning | Twilio segments at 160 GSM-7 chars (70 if any unicode). We let drafts up to 1600 chars; Twilio will split into multiple segments at send time. Billing is per segment. |

---

## 5. Known limitations (pilot scope)

- **Delivery status callbacks live.** Every outbound send passes a
  `StatusCallback` URL; Twilio POSTs to `/api/twilio/sms/status` on
  each transition. The handler verifies the signature, looks up the
  interaction by `metadata.twilio_message_sid`, and overwrites
  `metadata.twilio_status` + `twilio_status_updated_at` (and
  `twilio_error_code` on failures). Failed / undelivered transitions
  log loud server-side. No UI surface yet — values live in metadata
  for now; a "Couldn't deliver" badge on the customer detail page is
  a small follow-up.
- **No media (MMS).** Body-only sends. The `body` text-only path is
  the only thing wired.
- **No queue.** Approvals send synchronously inline with the Slack
  callback. If Twilio is slow, the Slack approval response is slow.
  Real outbound nurture at volume needs a background queue.
- **Drafter has no menu context.** `src/lib/sms-drafter.ts` doesn't
  query the shop's `services` table, so it never quotes a specific
  price. By design — gives the owner a clean draft to layer pricing
  into themselves. Worth revisiting once we want pricing in auto-
  drafts (would also want a confidence/disclaimer mechanism).
- **Drafter has no shop address / prep instructions.** The booking
  confirmation says when, not where or what to bring. Once shops fill
  in `shops.location` and (future) prep-notes per service, the drafter
  can include them. Today they get added by the operator at edit time.

---

## 6. After go-live

Next on the engineering side:

1. **Auto-draft SMS replies** for inbound SMS leads — when the
   classifier marks `is_lead`, also generate a one-line draft via
   Claude and stage it as a `send_sms` pending.
2. **Booking confirmation SMS** — when a `book_appointment` lands,
   queue a `send_sms` for "we'll see you {time}".
3. **Twilio status callbacks** — second webhook route so delivery
   receipts close the loop on the outbound interaction.
