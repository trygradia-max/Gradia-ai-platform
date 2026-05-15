# Google Calendar Go-Live

We reuse the **Aurinko** connection for Calendar — one OAuth, two
channels. There's no separate Google OAuth flow to wire up.

---

## 0. Prerequisites

- [ ] Migration `20260512130000_book_appointment.sql` applied to
      remote Supabase (`supabase db push` or paste in the dashboard).
      Adds the `book_appointment` action type and the calendar-event
      columns on the `appointments` table.
- [ ] Latest code deployed to Vercel.

---

## 1. Re-grant the calendar scopes (if you connected pre-Calendar)

Aurinko grants scopes at OAuth time. Existing shops connected before
this work shipped have only `Mail.*` permissions. To unlock calendar:

1. `/settings` → **Email receptionist** → **Disconnect**.
2. Click **Connect Gmail** again.
3. On the Google consent screen, you'll see Calendar permissions in
   addition to Mail — approve them.

New shops connecting for the first time get both sets of scopes by
default (`Mail.Read Mail.ReadWrite Mail.Send Calendar.ReadWrite`).

---

## 2. Update the Vapi assistant's `propose_booking` tool

The voice receptionist now passes a real ISO datetime when it can,
which is what lets us create the calendar event on approval. In the
Vapi dashboard, replace the `propose_booking` tool JSON with the
updated version in `docs/vapi-go-live.md` (it adds `iso_start_time`,
`duration_minutes`, and `timezone`).

Also re-paste the system prompt — it now explicitly tells Claude to
fill `iso_start_time` whenever a real time is named.

---

## 3. Smoke test

Call the Vapi number and book:

> *Hi, I'd like to book ceramic coating Saturday at 2pm. My name is
> Sam, phone is 555-123-4567.*

Expected:
1. Gradia confirms verbally: *"Perfect, we'll text Sam to lock in
   ceramic coating for Saturday at 2pm."*
2. A **booking** Slack approval card lands with the structured time
   rendered (e.g., "Sat, May 16, 2:00 PM · 90 min"), not just a free-
   text "when" string.
3. Approve in Slack. Within a second or two, the event appears on the
   connected Google Calendar.
4. Visit `/schedule` — the booking shows up under "Today" or the
   matching day.
5. Visit `/leads` — a `booked`-status lead exists for Sam.

If the caller's time is vague ("sometime next week") and Claude
doesn't fill `iso_start_time`, the action falls back to a `create_lead`
with status `quoted` — same as before. The approver clarifies and
edits before approving.

---

## 4. Common gotchas

| Symptom | Cause |
|---|---|
| Approval card says "Connect Google Calendar via Aurinko (in /settings) before approving bookings." | The shop's Aurinko token doesn't have Calendar scopes. Disconnect + reconnect in `/settings` to re-grant. |
| Slack card lacks the formatted time | The voice tool emitted `create_lead` (quoted), not `book_appointment` — meaning Claude didn't fill `iso_start_time`. Re-check the Vapi tool JSON and system prompt. |
| Calendar event appears with the wrong timezone | The Vapi assistant didn't pass `timezone`. Add the shop's IANA timezone (e.g., `America/Los_Angeles`) to the system prompt as a fixed value the model should always pass. |
| `/schedule` shows "Couldn't reach our calendar" | Aurinko token expired or scopes mismatch. Disconnect + reconnect in `/settings`. |
| Approving a booking creates the event but no lead | Bug — check Vercel logs. Open an issue with the pending action ID. |

---

## 5. Known limitations (pilot scope)

- **No conflict detection.** The engine creates the event blindly.
  Two approvers approving overlapping bookings will both land — last
  one wins on the calendar but both leads/appointment rows persist.
  Conflict detection is a follow-up.
- **No reschedule from inside Gradia.** Edits to time on
  `/approvals/[id]` before approval work fine. After approval, the
  edit has to happen in the calendar provider directly. A reschedule
  UI is a future task.
- **Primary calendar only.** Pilot writes to `calendarId = "primary"`.
  Multi-calendar shops (e.g., a separate "Customer Bookings" calendar)
  need a calendar picker in `/settings` — not built yet.
- **No notifications to the customer.** We don't send the booking
  confirmation as email/SMS yet — that's gated on outbound email/SMS
  work.

---

## 6. After go-live

Next on the engineering side:

1. Outbound email + SMS confirmation when a booking lands (depends on
   outbound channels).
2. Conflict detection (read events before creating).
3. Reschedule UI for booked appointments.
