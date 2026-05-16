# Aurinko Email Go-Live Checklist

Code side is done. The OAuth flow, webhook signature verification,
Claude classifier, and HITL plumbing all live in the repo. This is
what you need to set up on Aurinko's side and in env vars.

---

## 0. Prerequisites

- [ ] Migration `20260512110000_shop_aurinko.sql` applied to remote
      Supabase (`supabase db push` or paste in the dashboard).
- [ ] Latest code deployed to Vercel.

---

## 1. Create the Aurinko app

1. Sign up at <https://aurinko.io>.
2. **Dashboard → Apps → Create App.**
3. Pick **Email (read + write)** as the scope set. Gmail is fine for
   the pilot; Outlook/IMAP/etc. work the same way without code changes.

### Allowed redirect URIs
Add **both**:
- `https://gradia-ai-platform.vercel.app/api/aurinko/auth/callback`
- `http://localhost:3000/api/aurinko/auth/callback` *(for local dev)*

### Note three values from the app settings
- **Client ID** → `AURINKO_CLIENT_ID`
- **Client Secret** → `AURINKO_CLIENT_SECRET`
- **Signing Secret** → `AURINKO_SIGNING_SECRET`

---

## 2. Set Vercel env vars

In Vercel → Project → Settings → Environment Variables, add all three
above. Redeploy after saving (Vercel doesn't pick up env changes until
next deploy).

For local dev, drop the same three into `.env.local`.

---

## 3. Connect your inbox

1. Visit `/settings` in Gradia.
2. Under **Email receptionist**, click **Connect Gmail**.
3. Aurinko redirects you to Google's OAuth consent screen. Approve.
4. You'll land back at `/settings?email=ok` with a green **Connected**
   pill and your Gmail address shown.

Behind the scenes the callback:
- Exchanges the OAuth code for an account token.
- Reads your account info from Aurinko.
- Creates a `/email/messages` webhook subscription pointed at
  `/api/aurinko/webhook`.
- Persists `aurinko_account_id`, `aurinko_account_email`,
  `aurinko_access_token`, `aurinko_subscription_id` on your shop row.

---

## 4. Smoke test

Send a test inquiry **from a different email account** to the connected
Gmail. Something like:

> *Subject: Ceramic coating on a 2023 Model Y*
>
> Hey, I'm looking to get a ceramic coating done on my 2023 Tesla Model
> Y next week. What does that run? My number is 555-123-4567 if it's
> easier to call. — Sam

Expected:
1. Aurinko POSTs to `/api/aurinko/webhook` within a few seconds.
2. The handler verifies the signature, looks up your shop by
   `accountId`, fetches the message, records the interaction in the
   shared memory layer (channel = `email`), and runs the Claude
   classifier.
3. Because it's a clear lead, a `pending_action` (`create_lead`) is
   inserted with the customer name, phone (extracted from the body),
   vehicle, requested service, and a one-line summary.
4. A Slack approval card lands in your `SLACK_WEBHOOK_URL` channel.
5. Approving from Slack (or `/approvals`) lands the lead in `/leads`.

---

## 5. Common gotchas

| Symptom | Cause |
|---|---|
| Webhook returns **401 Invalid signature** | `AURINKO_SIGNING_SECRET` mismatch between Aurinko and Vercel, or system clock drift > 5 min. |
| Webhook returns **200 but `skipped: no shop`** | The Aurinko account ID isn't matched to a shop. The shop row should have the account ID after a successful connect — re-check `/settings` shows Connected. |
| No webhook events fire at all | Subscription wasn't created (check Vercel logs at the time of connect). Try disconnect → reconnect. |
| Newsletters becoming leads | Classifier marked them as a lead. Re-check the body — if it's a real edge case, we can tighten the system prompt in `lib/email-classifier.ts`. |
| Lead has empty phone | Sender didn't include one in the body — that's expected. The HITL Edit UX (task #4) will let you add it before approving. |
| Connect Gmail button is disabled | Aurinko env vars not set in Vercel. The settings page reads them at render time. |

---

## 6. Known limitations (pilot scope)

- **Tokens are encrypted at rest.** As of `20260515200000_encrypt_aurinko_token`,
  `aurinko_access_token_enc` is AES-256-GCM with `ENCRYPTION_KEY` from
  env (`src/lib/crypto.ts`). Anyone who only compromises the database
  doesn't get usable tokens. The threat model assumes Vercel env access
  stays gated separately.
- **Refresh flow not built.** Aurinko tokens are long-lived per their
  docs, but on expiry the user will need to disconnect → reconnect.
  A refresh job is a follow-up.
- **Outbound email isn't wired.** Aurinko has Mail.Send scopes
  requested, but the dashboard/Slack flow doesn't send replies yet —
  that's a separate task (Phase 2 nurture).
- **Multiple shops per Aurinko app share rate limits.** Fine at pilot
  scale; revisit when shop count crosses 10.

---

## 7. After go-live

Next: wire up `/leads/pending/[id]` so the Slack **Edit** button has a
real editor to land on (task #4).
