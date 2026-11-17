# Resume: Provider Boundary V1 (public SMS + email classification and immediate drafting)

Branch `claude/provider-boundary-sms-email`. Owner: Claude Code. **Do not merge.**
Base commit: `b3694ce8e65fe3c8d1bc413528623757dda3e803` (origin/main at start, 2026-11-16).

## Scope

First bounded Gradia-owned model/provider security boundary for PUBLIC inbound SMS and email:
classification (`sms-classifier.ts`, `email-classifier.ts`) and immediate drafting (`sms-drafter.ts`,
`email-drafter.ts`) only. Out of scope: billing, voice/Vapi, Agent OS storage, embeddings, deploy,
shared DBs, secrets, customer data, production, model credentials, live evals, any CRM mutation,
any weakening of approval, automatic multi-model fallback.

## Threat model (working draft)

Untrusted: message body, subject, sender display name, retrieved shop knowledge. Attacker goals:
role/policy override, tool use / exfil of secrets or system prompt, alternate recipient, fake consent /
price / booking / tool authority, bidi/zero-width/control smuggling, oversized input, malicious
structured output, replay, bypass of STOP, cross-tenant leakage, PII/secrets in logs.

Controls: deterministic preflight -> hold for human (raw evidence preserved, no draft/proposal/CRM/send);
PII-minimized bounded model input; strict output validation; model output never selects tenant,
recipient, channel, consent, purpose, policy, tool, price, booking or execution authority; provider
failure -> truthful hold; no raw content/credentials/prompts/PII in logs.

## Milestones

- [ ] M0 reading + audit (in progress: governing docs 1-2 read)
- [ ] M1 boundary module + preflight + tests
- [ ] M2 SMS/email classifier + drafter migration + route wiring
- [ ] M3 adversarial tests, no-PII-in-logs proof
- [ ] M4 docs, work log, rebase, full checks, PR

## Files (planned/touched)

(update as work proceeds)

## Last checks

none yet

## Uncommitted paths

this file (new)

## Exact resume command

```
cd /Users/harryhatch/Gradia/worktrees/claude-provider-boundary-sms-email && git status -sb && sed -n 1,200p docs/handoffs/PROVIDER_BOUNDARY_V1_RESUME.md
```
