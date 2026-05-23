# Demo recording scripts

Short scripts for 6 demo videos that should live on
`/how-it-works` (or as a YouTube playlist linked from there). Each
is structured as: **goal → setup → shots → narration**.

Target length 45-90 seconds each. Style: phone-recording-quality
is fine, not Hollywood. The voice should match the product —
collaborative "we/us," practical, no marketing fluff.

The whole playlist runs ~8 minutes and covers the agentic story
end to end.

---

## 1. Voice receptionist — "Gradia answers the phone"

**Goal:** convince a detailer that the AI receptionist sounds
human and proposes real bookings.

**Setup:** Vapi assistant + phone number provisioned. Slack
`#gradia-approvals` channel open in a second window.

**Shots:**
- Hold up your phone, dial the Vapi number.
- Speakerphone on. Speak normally: "Hi, I'm looking to get my
  Tesla detailed Saturday at 2pm. Full interior + paint
  decontamination."
- Let the AI quote + confirm. Hang up.
- Cut to Slack: the booking approval card appears.
- Tap Approve. Cut to `/schedule` showing the new event on
  Saturday at 2pm.

**Narration:** "Calls come in while we're under a car. Gradia
picks up, quotes from our menu, proposes the booking. We approve
on our phone — it lands on our calendar. Zero missed leads."

---

## 2. Inbound SMS auto-draft — "We type back even when we don't"

**Setup:** Twilio number live, knowledge base has at least the
deposit policy entry.

**Shots:**
- Text the shop's Twilio number from your phone: "Hey, looking
  to book a full detail. Do you take deposits?"
- Cut to Slack: approval card appears with a draft reply.
  Highlight the part where the draft mentions the deposit
  policy verbatim from the knowledge base.
- Tap Approve. Cut to the original phone showing the reply
  text arrive 2 seconds later.

**Narration:** "Texts get drafted on-brand, citing our actual
deposit policy — not Claude's guess. We tap once, the customer
hears back in seconds."

---

## 3. Co-owner widget — "What I'd tackle next"

**Setup:** dashboard with 2-3 stale leads + 1 upcoming
appointment in the next 24h.

**Shots:**
- Open `/dashboard` on a phone.
- Scroll to the **What I'd tackle next** card. Pan over the
  suggestions: "🔥 Sarah Chen — they replied recently, strike
  while it's warm" / "⏳ Mike Torres — 5 days old and still
  untouched."
- Tap "Draft follow-up" on Sarah Chen.
- Cut to Slack: SMS draft appears as an approval card.

**Narration:** "Gradia doesn't just react. It tells us who to
follow up on — hot leads we haven't pinged, customers gone
quiet, appointments coming up. One tap, the draft is ready."

---

## 4. BI chat — "Ask anything about the shop"

**Setup:** Some real or seeded data — a month of paid invoices,
some leads, some appointments.

**Shots:**
- Open `/chat` on a laptop.
- Type: "How much revenue did we collect last week?"
- Watch the streamed answer appear with the actual number.
- Type follow-up: "Who's our hottest lead right now?"
- Answer comes back with a name, phone, heat score, and the
  signal driving it.
- Type: "What's our deposit policy?"
- Answer cites the shop knowledge entry verbatim.

**Narration:** "Open Gradia, ask anything — revenue, hot leads,
our own policies. It's grounded in our actual data and our own
words. No spreadsheets."

---

## 5. Whisper — "Charge Smith $450 for ceramic"

**Setup:** Stripe Connect onboarded, charges enabled.

**Shots:**
- Open `/dashboard` on mobile.
- Tap the Whisper button (the mic icon).
- Hold to record: "Charge Smith $450 for ceramic coating on his
  Tesla."
- Release. Cut to Slack: charge approval card with Smith's
  email + amount + description, pre-filled.
- Approve. Cut to the customer's inbox (test account): the
  Stripe-hosted invoice email lands.

**Narration:** "When we're done with a car, we just say what we
did into the dashboard. Gradia drafts the invoice with the right
amount and emails it from our Stripe account. Cash flow without
the laptop."

---

## 6. Channel center + setup pill — "Connect everything in 90 minutes"

**Setup:** brand new account, nothing connected yet.

**Shots:**
- Sign in (use a fresh account or screenshot the welcome modal).
- Welcome modal appears: 5 steps with deep-links.
- Click "Voice receptionist" → lands on `/settings#voice`.
- Cut to setup pill in header reading "Setup 0/7."
- Speed-run connecting voice → email → SMS (fast forward / cuts).
- Pill ticks 1/7 → 4/7 → 7/7.
- Land on `/dashboard` with green "All channels live" pill.

**Narration:** "Five integrations, ninety minutes start to
finish. Voice, email, SMS, payments, DMs — all sitting in one
HITL inbox in Slack."

---

## How to record

- Phone: any modern iPhone/Pixel. Hold landscape.
- Screen: macOS Cmd+Shift+5 → record selected portion → choose
  the browser window only.
- Voice: built-in mic is fine for screen recordings; for the
  phone-call demo, use the iPhone's screen recorder + sound to
  capture both sides.
- Edit: iMovie / CapCut / Descript. Trim dead air. Don't add
  music. Don't add captions you wouldn't write in product copy.

## Where they live

Upload to YouTube unlisted (so the URL is private but
embeddable). Add an `<iframe>` per video to `/how-it-works`
(currently the page has 5 channel cards — replace one with the
video, or add a new "See it in action" section above the
channels grid).
