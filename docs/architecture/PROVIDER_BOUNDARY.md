# Provider boundary V1 — public SMS and email

_2026-11-16. First bounded Gradia-owned model/provider security boundary. Scope is
**classification and immediate drafting for public inbound SMS (Twilio) and email
(Aurinko) only**. It implements, for these four call sites, the "deterministic input
classification and PII redaction at provider boundaries" item in
`AGENT_OS_LAYERING.md` (required next slice 5) and Gate 2 of
`../roadmap/AGENTIC_OS_MASTER_BUILD.md`. It is not the common model adapter (slice 2)
and it activates nothing: the production write guards, provider activation and
release gates are unchanged._

## Threat model

Untrusted, attacker-controlled data: the message **body**, the email **subject**, the
sender **display name**, and retrieved **shop knowledge** (a poisoned FAQ is an
injection channel). Goals the boundary defends against: role/tool/policy override,
secret or system-prompt exfiltration, an alternate recipient, fake consent / price /
booking / tool authority, bidi / zero-width / control-character smuggling, oversized
input, malicious structured output, replay, bypass of STOP, cross-tenant leakage, and
PII or secrets reaching a provider or a log.

## Design

```
inbound (verified) ─► evidence stored raw ─► preflight (deterministic) ─┬─ hold ─► marker, STOP
                                                                        │
                                                                        └─ clear ─► prepareForModel ─► model ─► strict schema ─► output policy ─► route
```

1. **Evidence is never normalized.** The customer-role interaction row (and, for SMS,
   the intake envelope) holds exactly what the sender sent. Normalization happens only
   where text leaves the evidence store: model input, model-output checks, and
   proposal fields (pending actions, customer name, draft text).
2. **Preflight** (`provider-boundary/preflight.ts`) is a small, finite, versioned rule
   set over a *folded* form of every untrusted field (NFKC, invisible characters
   removed, look-alike letters folded, lower-cased; plus a squashed form for spaced /
   punctuated / leetspeak spellings). Findings: `override_role`, `override_policy`,
   `tool_instruction`, `secret_request`, `alternate_recipient`, `claimed_authority`,
   `obfuscated_input` (bidi overrides, control characters, ≥3 invisible characters),
   `oversized_input` (SMS body 1,600; email body 50,000, subject 300, display name 200;
   knowledge 12,000 — checked on the *raw* field). It is deliberately narrow (it is
   not an AI classifier and does not try to be complete). The structural controls below
   are the guarantee; the preflight removes the obvious cases early and cheaply.
3. **A hold is not a rejection.** The route runs the preflight *before any CRM write or
   model call*. On a hold: raw evidence stays; **no** model call, metering, customer
   creation (a read-only lookup may link the marker to a known customer), lead
   proposal, draft, send or provider effect. Exactly one content-free,
   idempotent `system`-role thread note is written
   (`metadata.boundary_hold_key = <stage>:<provider message id>`; fixed text, closed
   reason codes, no customer content). "Exactly one" is enforced by the database, not by
   a lookup: the marker is a single `INSERT`, and the partial unique index
   `interactions_provider_boundary_hold_unique` (migration `20261116120000`) over
   `(shop_id, channel, boundary_hold_key)`, limited to marker rows (`role = 'system'`,
   `source = 'provider_boundary'`, `kind = 'hold'`), makes simultaneous duplicate
   deliveries race to one winner. The loser gets `23505`, which `recordBoundaryHold`
   reports as `{ ok: true, recorded: false }`; any other error is `{ ok: false }`.
   Other interaction rows (raw customer evidence, replies, ordinary notes) are outside the
   index. `shop_id` leads the key, so tenants cannot collide; cascades and RLS are
   unchanged. STOP/START keyword handling is compliance, not
   content, and still runs for a held message; a sender who said STOP is never
   auto-drafted a reply.
4. **PII minimization.** The model receives only a bounded, redacted excerpt: phone
   numbers, email addresses, links, provider ids (Twilio SIDs, Stripe-style ids, UUIDs,
   long hex), tenant ids, headers, secrets and quoted reply chains / signatures are
   removed; angle brackets are removed so text cannot close or spoof the data fences;
   the sender's number/address and display name are not sent at all. The email `phone`
   field is no longer asked of the model — code extracts it.
5. **Structured output is untrusted.** Strict schemas (unknown keys are malformed),
   then an output policy: short fields must be plain single-line values (no contact
   data, links, placeholders, instructions, smuggling characters); a draft may not
   carry contact details, links, markup, redaction placeholders, a booking or consent
   claim, or a dollar amount / percent-off / "free" claim the shop's own knowledge does
   not state. An unsafe result is held whole — nothing is repaired.
6. **Authority stays in code.** Tenant (shop bound by the verified To-number / Aurinko
   account), recipient (the verified sender), channel, consent, service purpose,
   policy, tool, price, booking and execution are never inputs to, or fields of, any
   model result. Drafts reach the existing approval engine unchanged (`pending_actions`
   → `approvals.ts` → send policy); nothing here weakens an approval, consent,
   proof or send gate.
7. **Provider failure is a truthful hold.** A provider error, a deadline (20–30 s, with
   an abort signal), malformed or unsafe output returns `held`, never `is_lead:false`.
   One call per task: no cross-model fallback. SMS: the event completes as a hold (it
   used to 5xx-retry); a *thrown* (unexpected) classifier error still meters and fails
   the claim as before. Email: the old catch-and-**treat-as-inquiry** fail-open path is
   gone — that path used to propose a lead and a draft when classification failed.
8. **Logs carry closed fields only** (`provider-boundary/log.ts`: task, stage, outcome,
   reason codes, duration). Route catch blocks log the error *class*, never its message
   (messages can embed customer text or provider response bodies).

## Where it lives

| File | Role |
| --- | --- |
| `src/lib/provider-boundary/text.ts` | normalization, folding, invisible-character counts, defang |
| `…/redact.ts` | PII / identifier / secret / header / quote minimization, `prepareForModel` |
| `…/preflight.ts` | finite rule set, limits, `preflightInbound`, `preflightKnowledge` |
| `…/output-policy.ts` | short-field and draft checks |
| `…/run.ts` | `runBoundaryTask` (deadline, abort, strict parse, accept, typed hold), provider seam |
| `…/hold.ts` | idempotent content-free hold marker |
| `…/log.ts` | closed-field logging, `safeErrorName` |
| `src/lib/{sms,email}-classifier.ts`, `{sms,email}-drafter.ts` (inbound reply drafters only) | migrated call sites |

Reuse for the next call site: build the redacted request with `prepareForModel`, define
a strict schema, call `runBoundaryTask` with an `accept` that applies the output policy,
and let the caller own tenant/recipient/consent.

## Tests

`eval/provider-boundary.test.ts` (units: preflight table incl. obfuscation variants,
oversize, normalization, redaction, deadline/abort/malformed/malicious output, classifier
and drafter behavior, logging, hold marker) and `eval/provider-boundary-routes.test.ts`
(real classifiers/drafters/preflight with a mocked model client through the real Twilio
and Aurinko routes: legitimate leads preserved; prompt override, secret request,
alternate recipient, fake consent/price/booking/tool, subject / body / display-name /
knowledge injection, bidi / zero-width / control variants, oversize, malicious structured
output, replay, STOP precedence, tenant isolation, provider timeout / outage / malformed
output, and a no-PII/secret-in-logs proof). Every provider is a mock. Mutation check:
neutralizing the preflight fails 83 of these tests; neutralizing the output text policy
fails 16.

## Honest limits (not done in this PR)

- **Live evaluations were not run** (prohibited here). The prompts gained an
  untrusted-data fence and a no-contact-details rule and drop the sender/phone lines;
  `eval/classification.eval.test.ts` and the golden sets must be run by a human
  (`npm run eval`) and pass before any provider activation (principle 6).
- **A held message has no dedicated review queue.** Visibility is the thread note plus,
  for SMS, the existing unresolved-intake queue. A "held by safety" surface in Home /
  Approvals is a follow-up.
- The preflight is finite; a novel phrasing it misses is still contained by the
  structural controls (strict schema, recipient/tenant/consent in code, output policy,
  approval-first staging), but it is not a claim of complete injection detection. The
  ambiguity tradeoff is intentional: unusual-but-legitimate text (e.g. asking to send a
  quote to someone else's address) may be held for a human.
- Not migrated: booking-confirmation, reminder and custom-agent drafters, the owner
  agent, voice, recovery extraction, BI. The routes' `recordInteraction` still sends raw
  content to the embeddings provider (embeddings are out of scope here).
- The Aurinko route has no provider-event replay claim (pre-existing). A replayed
  *clean* email can still duplicate its interaction / lead card / draft; only the hold
  marker is idempotent (durably, under concurrency: see the unique index above). The "classification rate-limit exceeded" path still returns
  without a classification (pre-existing).
- Fixed on the way: the inbound email drafter prompt contained a literal `{make/model}`
  that LangChain treated as a template variable, so every inbound-email draft threw
  before reaching the model and was swallowed by the route's best-effort try/catch. It is
  now escaped (`{{make/model}}`) and covered by a route test.
- The two integration files touched (`twilio-inbound-replay`,
  `delivery-lifecycle-acceptance`) changed only their classifier/drafter mock return
  shapes. They pass against the disposable stack after the review follow-up (18 and 5
  tests). `eval/integration/provider-boundary-hold.int.test.ts` covers the concurrent
  hold-marker race (24 simultaneous writers => one row) on real Postgres.
