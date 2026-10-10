# Public website intake — October 8, 2026

This bounded backend slice lets an anonymous visitor submit inquiry evidence to an
owner-configured form. It reuses `record_lead_intake` and the existing identity
review queue. It does not resolve identity, create customers/leads, record consent,
start qualification, or send a communication. The existing signed-in website-form
endpoint is unchanged.

## Owner configuration contract

`configurePublicIntakeForm` and `listPublicIntakeForms` are session-bound server
actions backed by owner-only database RPCs. Owner authority must still be active.
The configuration input is `{shopId, formId, origin, enabled, revision}`. Generate
a new UUID for `formId`; use revision 0 for creation and the listed revision for
changes. Origin is one exact canonical HTTPS origin, without credentials, path,
query, fragment, wildcard, or trailing slash. Disabled is the table default; enable
requires an explicit owner command. Configuration errors/uncertainty require a fresh
list before retrying. A form cannot be rebound to another shop. Creation and the
latest configuration change retain the acting owner and timestamps.

No Settings UI is added in this slice to avoid overlapping Cursor's current work.
A following UI task can use these actions in the existing connector surface. An
embed installer, list/configuration browser acceptance and public anti-bot/provider
acceptance remain prerequisites for pilot readiness. This is not a complete self-
serve website connector.

## Submission contract

`POST /api/intake/public-form/{formId}` accepts JSON with:

- `submission_id`: a fresh UUID per inquiry; reuse it and identical content for a
  transport retry. Changed content requires a new UUID.
- At least one of `phone` or `email`.
- Optional `display_name`, `message`, `vehicle_text`, `service_text`.

The browser must send the configured `Origin`. Successful requests return only
HTTP 202 and `{accepted:true}`. No shop, customer, workflow or evidence identifiers
are returned. An exact duplicate receives the same response and makes no new
records. Changed content with the same UUID is a 409. Contact similarity never
combines people or conversations. Each new submission enters identity review.
Submitted phone/email are unverified text, not consent or proof of identity.

`shop_id`, `thread_key`, consent flags and unknown fields are rejected. The route
bounds the actual streamed body to 16 KiB even with a forged/missing Content-Length;
field lengths are bounded again before database ingestion. Non-JSON is refused.
No raw submission/database error is logged. Unknown storage outcomes return 503
with instructions to retry the same id/content; there is no automatic retry.

## Isolation, revocation and abuse limits

Form ids are public routing keys, not credentials. Exact-origin CORS prevents
unapproved browser origins; a bot can forge Origin, so it is not authentication
or a replacement for bot protection. OPTIONS checks the configured origin and
permits only POST/Content-Type without credentials or mutation. POST checks again
inside the atomic database command. Unknown, disabled and wrong-origin forms share
a generic rejection. Revoked owner membership also stops intake.

Database acceptance serializes with configuration/membership changes on the shop
row. The provider event key includes form UUID and submission UUID; replay across
shops cannot link their data. Rate limits are 30 new submissions per rolling minute
and 500 per rolling 24 hours across all public forms for one shop. Concurrent
requests cannot multiply that allowance. Exact retries do not consume quota. A
429 includes Retry-After 60; daily exhaustion may require a longer wait. These
bounds limit intake writes, not distributed network traffic or deliberate quota
exhaustion; provider-level abuse controls remain an activation gate.

Tables deny direct access even to service role. Only authenticated owner sessions
can configure/list; only service role can resolve public origins and submit. The
public HTTP route never accepts a user-selected tenant or service credential.
The existing approvals, consent and delivery machinery is not invoked.

## Verification and release

Migration `20261008150000_public_form_intake.sql` is additive. Configuration and
submissions use the same transaction as their authority/revision/replay checks.
The dedicated unlinked local stack is `gradia-public-form-tests` on port 57331;
`node scripts/isolated-check.mjs integration --forms` selects it explicitly.
It is separate from Claude Code's disposable databases. CI continues using its
normal isolated stack and applies the same migration from zero.

Unit tests cover HTTP/schema/CORS/body limits, safe failures and owner action result
binding. Database tests cover role boundaries, direct-access denial, cross-shop
isolation, concurrent retries/quotas, stale configuration, revocation and absence
of CRM/consent/delivery effects. See `docs/AI_WORK_LOG.md` for completed results.

Automatic deployments remain disabled. No shared/production migration, provider
activation or real visitor submission is included. Release requires owner setup UI,
public-origin browser acceptance and an explicit operational rollout.

## Upload deadline and browser retry helper — October 9

The HTTP body reader now permits at most ten seconds total after reading begins,
including slow streams that keep sending small chunks. Caller abort also ends the
read. Timeout returns 408 with retry instructions and the configured CORS origin;
no submit RPC is called. Oversize, timeout and abort cancel the stream without
waiting indefinitely for its cancellation hook. This bounds application body
reading, not binding/database/network infrastructure time or distributed abuse.

`src/lib/public-form-client.ts` provides `preparePublicFormSubmission` for a future
form/embed UI. Configuration uses the exact canonical HTTPS app origin and form
UUID. The returned handle owns one validated, immutable payload and generated
submission UUID. It makes no request until `submit()` is called.

```ts
const inquiry = preparePublicFormSubmission({
  appOrigin: "https://gradia-ai-platform.vercel.app",
  formId: configuredFormId,
  fields: { email, message },
})
const result = await inquiry.submit()
// Keep this same handle for an explicit user retry:
// const retryResult = await inquiry.submit()
```

Keep the handle in component state/ref across renders and button clicks. Never
create a new handle per retry. The helper snapshots normalized fields, so subsequent
edits to the input object cannot change the submitted bytes. Concurrent calls
share one request; a confirmed acceptance is cached. It sends no cookies, refuses
redirects, and leaves Origin to the browser. The whole attempt, including parsing
a response body, has a 20-second deadline. There are no automatic retries.

Result contract:
- `accepted`: the endpoint returned 202 with `accepted: true`; inquiry evidence
  was received, not a booking, consent grant or permission to send.
- `rejected`: 400/403/409/413/415. Show correction/access/conflict guidance, without
  presenting raw server details. A 409 needs investigation/new content, not a blind
  retry with a newly generated id.
- `retryable`: 408/429. Retain this handle and offer a manual retry; for 429 wait
  at least 60 seconds and explain that daily limits can require longer.
- `uncertain`: network failure, timeout, malformed success or other status. State
  that acceptance could not be confirmed; retry only this same handle/content.

No request data is written to browser storage. A reload loses the handle; the UI
must warn before abandoning an uncertain inquiry. Do not automatically create a
replacement inquiry after reload, edits or timeout. Persistent recovery, an actual
embed, browser-origin acceptance and anti-bot controls remain separate tasks.
This helper neither configures/enables a form nor changes the database contract.
