# Outbound Email

Mirror of the SMS outbound layer, against the same Aurinko connection
that handles inbound. No new env vars, no new provider setup — the
`Mail.Send` scope was already granted when the operator first
connected Gmail.

Two paths land outbound email from Gradia:

1. **AI-initiated (HITL-gated)** — agents / inbound classifier stage
   a `send_email` `pending_action` via `proposeOutboundEmail`. Slack
   approval card with To / Subject / Body preview + Approve & send /
   Edit / Reject. On approval, the engine calls Aurinko's send
   endpoint and records the message in `interactions` (channel=email,
   role=gradia, metadata.direction="outbound").
2. **Operator-direct compose** — *deferred to a follow-up.* No
   inline compose UI yet; operators can still kick off a reply by
   firing `proposeOutboundEmail` from a server context, then approving
   their own draft in Slack. The Quick Reply pattern that exists for
   SMS will mirror over once we add an `EmailQuickReply` component.

---

## 0. Prerequisites

- [ ] Aurinko Gmail connection live (`docs/aurinko-go-live.md`). The
      same OAuth grant powers inbound and outbound.
- [ ] Migration `20260516100000_send_email_action.sql` applied.
      Adds `send_email` to the `pending_action_type` enum.
- [ ] Latest code deployed to Vercel.

---

## 1. Triggers live

**Inbound email auto-draft.** When the Aurinko webhook receives a new
message and the classifier marks it as a lead, `/api/aurinko/webhook`
also calls `src/lib/email-drafter.ts` (Claude Haiku 4.5, on-brand
we/us voice, plain text, ~3–6 sentences, signed "— Gradia at
{shop_name}", never quotes price or commits to a time). The draft
includes a `Re: {original subject}` subject line. The pending action
lands as `source: "email_auto_draft"` with the inbound message ID in
metadata for traceability.

Operators see two cards per inbound email lead: the lead approval,
then the email draft. Approving the draft fires the outbound; the
customer gets it from the shop's own mailbox (no spoofed sender —
Aurinko sends as the connected Gmail).

Drafter or Slack failures are best-effort — neither blocks the lead
proposal from landing.

---

## 2. AI-initiated sends (HITL)

Any server-side code with a logged-in operator context can stage a
draft for approval:

```ts
import { proposeOutboundEmail } from "@/app/actions/outbound-email"

const result = await proposeOutboundEmail({
  to_email: "sam@example.com",
  subject: "Quick follow-up on your ceramic quote",
  body: "Hey Sam — wanted to make sure you got our quote last week...\n\n— Gradia at Apex Detailing",
  customer_name: "Sam Rivera",
  reason: "Nurture · day 7 no-reply",
})
```

That posts an approval card with the To, Subject, Body preview, and
Reason. The approver can:

- **Approve & send** — engine calls Aurinko, records the outbound
  interaction, marks the pending `approved` with the Aurinko
  message ID as `result_id`.
- **Edit** — deep-links to `/approvals/{id}` where the email editor
  takes over (To / Customer / Subject / Body / Reason). Save changes,
  then approve.
- **Reject** — drops it.

---

## 3. Smoke test

1. From a personal email account, send an inquiry to the connected
   Gmail with a real-feeling subject and body.
2. Within seconds, two Slack approval cards arrive: the lead, then
   the email draft.
3. **Edit** the draft to taste, **Approve & send**.
4. Your personal inbox receives the reply from the shop's Gmail.
5. The outbound message also appears in `interactions` for the
   matching customer (channel=email, role=gradia,
   metadata.direction="outbound").

---

## 4. Common gotchas

| Symptom | Cause |
|---|---|
| Approval rejects with **"Connect Gmail via Aurinko (in /settings) before approving emails."** | The shop's Aurinko token is missing or decryption failed. Disconnect + reconnect in `/settings`. |
| Aurinko returns 403 / scope error | Tokens granted before Calendar/Send scopes were added still have only `Mail.Read`. Disconnect + reconnect to grant the current `Mail.ReadWrite Mail.Send Calendar.ReadWrite` set. |
| Reply arrives as a new thread, not a reply | Pilot scope — we send a fresh message rather than threading. Proper threading is a follow-up enhancement when Aurinko exposes a reference-message field. |
| HTML formatting in the draft | The drafter is prompted to produce plain text. If you see HTML tags, re-check the drafter system prompt or the operator's edit didn't sneak HTML in. |
| Draft mentions a price | Drafter should never quote pricing; treat as a regression and tighten the system prompt in `src/lib/email-drafter.ts`. |

---

## 5. Known limitations (pilot scope)

- **Plain text only.** No HTML, no images, no signatures with logos.
  Predictable rendering across clients; easy to reason about.
- **No threading.** Customer sees a standalone email rather than a
  threaded reply. Aurinko hasn't documented a reference-message
  parameter; revisit when we want true conversation continuity.
- **No operator-direct compose UI yet.** Mirror of the
  `<SmsQuickReply>` for email is a small follow-up — same shape,
  different fields.
- **No bounce / delivery feedback.** Aurinko doesn't surface
  delivery receipts back to us synchronously. If a send fails on
  the provider side, we'd see it in the response; once delivered,
  we don't get later "bounced after 24h" signals.
- **No attachments.** Add `attachments` to the proposal payload
  + Aurinko's attachments API when we need it.

---

## 6. After go-live

Layered triggers to add next:

1. **Booking-confirmation email** — when `book_appointment` lands,
   queue a `send_email` confirmation alongside the SMS one. Same
   drafter shape, just a longer body.
2. **Day-of reminder email** — same idea as the 24h SMS reminder cron,
   for customers who prefer email.
3. **Operator-direct compose** — `<EmailQuickReply>` on
   `/approvals/[id]` for email-source pendings and on the customer
   detail page.
