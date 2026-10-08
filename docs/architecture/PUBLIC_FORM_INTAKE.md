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
