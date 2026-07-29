# Planned Evaluation — Transactional Email

_Created 2026-07-27 (vendor-architecture amendment). Planning only — no vendor is selected or installed. Adoption requires the 17-point checklist in `../README.md` incl. founder approval._

## Why this evaluation exists

Gradia has **three distinct kinds of email**, and no single provider should be assumed to control all three:

| Kind | What it is | Today |
|---|---|---|
| 1. Connected-mailbox conversations | The shop's own mailbox: inbound leads, replies to customers — the shop's voice from the shop's address | **Exists** via Aurinko (transitional); stays with the mailbox connection, whatever that becomes (see `google-calendar.md` / `microsoft-graph.md`) |
| 2. Application-generated transactional email | Gradia-to-owner/system mail: member invites (E01/Q-17), trial notices (D-005), usage/cap warnings, monitoring alerts (P0-012 candidate channel), billing receipts beyond Stripe's own | **Does not exist — notable gap.** Nothing in the platform can send email except through a shop's connected mailbox |
| 3. Campaign email | Owner-approved outreach to customers | **Exists** — sent through the shop's connected mailbox via the approval engine (correct: campaigns come from the shop, not from Gradia infrastructure) |

This evaluation covers slot **2 only**. Slots 1 and 3 are explicitly out of scope here.

## Requirements (transactional slot)

1. **Deliverability** — dedicated domain (e.g. mail.gradia domain — final domain **requires verification**), SPF/DKIM/DMARC, sender reputation isolated from any customer content.
2. **Templates** — versioned, reviewable; chrome copy discipline applies (narrator voice, `strings.ts` spirit).
3. **Webhooks** — bounce/complaint/delivery events, signature-verified, carrying provider event identifiers for idempotent processing (D-023), following the existing four-webhook security pattern.
4. **Suppression lists** — automatic bounce/complaint suppression; owner-level unsubscribe handling for non-critical notices.
5. **Sandbox/test environment** — non-prod sending mode for CI and staging.
6. **Cost** — negligible at pilot volume; pricing model **requires verification** per candidate.
7. **Tenant isolation** — recipient scoping by shop; no cross-shop template variable leakage.

## Current state in Gradia

No transactional sender exists. Consequences already visible in planning: E01 invitations have no delivery channel ("invite email sender identity" flagged in E01), D-005 trial notices have none, P0-012 alert delivery is building a destination-agnostic seam partly because email isn't available.

## Gradia-owned boundary

A Gradia-owned transactional-mail interface (one send function + template registry) so the vendor is swappable (D-029 logic). It must remain **separate** from the approval-engine send path — transactional mail is system mail, not customer outreach, and must never bypass or blur the one-send-path invariant for customer-facing messages.

## Trigger / timing

Blocking dependency for **E01 invitations** — the first real need. Evaluate during P1 planning; do not adopt during P0.

## Candidate options (not selected)

Resend · Postmark · Amazon SES. Capabilities vs requirements 1–6: **requires verification** at evaluation time.

## Open questions → decision queue

New queue item when E01 tickets are cut (vendor choice + sending domain) · whether P0-012 alerts should use email at all (Q-08 covers destination) · whether Stripe's own receipt emails suffice for billing (likely yes initially — **requires verification**).
