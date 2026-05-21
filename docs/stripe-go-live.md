# Stripe Go-Live Checklist

Stripe is wired up as **Connect Standard** — shops own their own
Stripe account; Gradia charges on their behalf via the
`Stripe-Account` header. **We never store a per-shop secret key.**
The only thing on the shop row is the `acct_XXX` connected-account
ID, which is not a credential.

Charges go through **Stripe Invoices** with `collection_method =
send_invoice`, so the customer gets an email with a hosted-payment
link. **No card-on-file required.** Perfect for the detailer-after-
the-job workflow.

---

## 0. Prerequisites

- [ ] Migration `20260515100000_stripe_charge.sql` applied to remote
      Supabase. Adds `charge_customer` to the `pending_action_type`
      enum and the `stripe_account_id` / `stripe_charges_enabled`
      columns on `shops`.
- [ ] Latest code deployed to Vercel.

---

## 1. Create / pick the Stripe platform account

This is **Gradia's** account, not a shop's. One account total.

1. Sign in to <https://dashboard.stripe.com>.
2. From the Stripe Dashboard → **Settings → Connect**, enable
   Connect for your platform if you haven't already.
3. Under **Settings → Connect → Onboarding options**, set
   **Account type** to **Standard** for the pilot. This means each
   shop manages their own Stripe Dashboard, with full visibility
   into their charges. (Express / Custom can come later if we
   want a more white-labeled experience.)
4. Note two values:
   - **Secret key** — `sk_test_...` while in test mode, swap to
     `sk_live_...` for production. From Developers → API keys.
   - **Connect client ID** — `ca_...`. From Settings → Connect →
     Onboarding options.

---

## 2. Set Vercel env vars

In Vercel → Project → Settings → Environment Variables:

```
STRIPE_SECRET_KEY=sk_test_...      # or sk_live_... for prod
STRIPE_CONNECT_CLIENT_ID=ca_...
STRIPE_WEBHOOK_SECRET=whsec_...    # see step 2b
```

Drop all three into `.env.local` for local dev. **Redeploy** after
saving.

### 2b. Wire the paid-status webhook

In Stripe Dashboard → **Developers → Webhooks → Add endpoint**:

- **Endpoint URL:** `https://gradia-ai-platform.vercel.app/api/stripe/webhook`
- **Listen to:** *Events on Connected accounts* (this is the key
  toggle — without it, events fire only for the platform account)
- **Events to send:** `invoice.paid`, `invoice.payment_failed`,
  `charge.refunded`

Copy the endpoint's **Signing secret** (`whsec_...`) into the
`STRIPE_WEBHOOK_SECRET` env above. Stripe will send a test event on
endpoint creation; the handler returns 200 for any event type it
doesn't act on, so the test won't generate a Slack post.

> While in test mode, you can also use `sk_test_...` and Stripe's
> test card numbers (e.g. `4242 4242 4242 4242`) end-to-end without
> moving any real money.

---

## 3. Connect the pilot shop

1. As the shop owner, visit `/settings` in Gradia.
2. Under **Payments**, click **Connect Stripe**.
3. You're redirected to Stripe's hosted onboarding flow.
4. Fill in business info, identity, bank details. (In test mode,
   Stripe accepts dummy data — see their test-mode docs.)
5. When done, Stripe redirects back to `/settings?stripe=ok`.
6. The card should now show **Connected** with charges enabled.

If onboarding wasn't fully completed, the card shows **Needs more
info** — click **Continue onboarding** to pick up where you left off.

---

## 4. The Whisper "charge X $Y" demo

This is the headline:

1. From `/dashboard`, hit the **Talk to us** mic.
2. Say something like: *"Just finished the Smith job, charge her
   $450 for ceramic coating."*
3. Whisper transcribes → Claude classifies as `charge_customer` →
   pulls out name + amount + description.
4. If we have a customer named "Smith" with an email on file, the
   pending action lands pre-filled. If not, the approval card shows
   "Email missing — edit to add."
5. A **Slack approval card** lands in the shop's channel:
   *"Approval needed: Charge $450.00 — Smith — Email: …"* with
   Approve & send invoice / Edit buttons.
6. Tap **Approve & send invoice** in Slack.
7. Within a couple seconds, Stripe creates a Customer (if needed),
   an Invoice Item ($450), an Invoice, finalizes it, and emails
   the customer the hosted-payment URL.
8. The Slack card flips to **Invoice sent** with a link to the
   Stripe-hosted invoice.
9. Customer clicks the email link, pays. Funds land in the shop's
   Stripe balance.

If the customer doesn't have an email on file yet, hit **Edit** on
the Slack card → land on `/approvals/[id]` → add the email →
**Save & approve**.

---

## 5. Smoke test (test mode)

1. Create a test customer in Stripe's Dashboard → Customers, or
   let Gradia create one via the charge flow.
2. Say *"charge test customer 25 dollars for wash"* into Whisper.
3. Approve in Slack.
4. Open the invoice link. Pay with Stripe's test card
   `4242 4242 4242 4242` (any future expiry, any CVC).
5. The Stripe Dashboard → Connected accounts → [your shop] →
   Payments shows the test charge.

---

## 6. Common gotchas

| Symptom | Cause |
|---|---|
| Approval rejects with **"Finish Stripe onboarding in /settings before approving any charge."** | The shop completed Connect onboarding but charges aren't enabled yet (Stripe sometimes needs additional verification). Re-open `/settings` and click **Continue onboarding**. |
| Approval rejects with **"Charge needs the customer's email — open the editor and add it before approving."** | Customer record has no email and Whisper didn't pick one up. Hit **Edit** on the Slack card to add it. |
| Stripe returns `parameter_invalid_empty` or similar | Whisper extracted the wrong field — edit the proposal in `/approvals/[id]` before approving. |
| Customer doesn't get the email | Check the Stripe Dashboard → Customers → [customer] → Email log. Stripe may have throttled or rejected the address. |
| Whisper says "charge" but creates a `create_lead` instead | Intent classifier was uncertain — rephrase ("bill Sam $450 for ceramic" usually classifies cleaner than "Sam owes me $450"). |
| Charges show in test mode after switching to live key | The connected accounts onboarded under a test key don't migrate to live mode. Re-onboard each shop after flipping `STRIPE_SECRET_KEY` to `sk_live_...`. |

---

## 7. Known limitations (pilot scope)

- **One charge = one invoice.** Stripe's hosted invoice is a clean
  customer experience but isn't a real-time card charge. The customer
  gets an email and chooses when to pay. For "tap the chip reader
  right now" UX we'd want Stripe Terminal — separate body of work.
- **No refund UI inside Gradia.** Refunds happen in the shop's
  Stripe Dashboard. A "refund last invoice" Whisper intent is a
  reasonable next step but not built.
- **No platform fee.** We're not taking a cut of the charge. When/if
  we want to, add `application_fee_amount` on the invoice create
  call in `src/lib/stripe.ts`.
- **Paid-status webhook live.** `/api/stripe/webhook` receives
  `invoice.paid`, `invoice.payment_failed`, and `charge.refunded`
  events for every connected account (Stripe routes Connect events
  through the platform's webhook with `account` set). Signature
  verified per Stripe spec (`Stripe-Signature` header, HMAC-SHA256 on
  `${timestamp}.${rawBody}`, 5-min tolerance). Each event posts a
  Slack notice ("Paid · Smith · $450" / "Payment failed · …" /
  "Refunded · …") and updates the originating interaction's metadata
  with `stripe_payment_status` (and `stripe_refund_status` when
  applicable) so badges can surface on the customer detail timeline
  in a follow-up. Refunds also net the local `payments` mirror so
  revenue tiles + BI chat stop over-reporting. Set
  `STRIPE_WEBHOOK_SECRET` in Vercel env.
- **No `/customers` view in Gradia.** Editing the customer's email
  on the charge card before approving works fine, but ongoing
  customer-record management still lives in the database / Stripe.

---

## 8. After go-live

Next on the engineering side:

1. **Stripe webhook for paid invoices** — close the loop on
   collection so the shop sees "Smith paid" inside Gradia.
2. **Booking-deposit charges** — when a `book_appointment` is
   approved, optionally fire a `charge_customer` for a deposit
   amount (per service, per shop preference).
3. **Refund support** — Whisper intent + executor.
