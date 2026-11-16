# Resume: server-written voice identity and launch-gate columns on `public.shops`

Branch `claude/security-fix-remaining-voice-columns`, started from `origin/main` `c71035f`.
Owner: Claude Code. Do not merge. No live Vapi/Twilio, shared/production data, secrets, deploy,
provider configuration, billing/catalog changes, or A2P registration-table changes (another lane).

## Scope

Make these `public.shops` columns non-forgeable by `anon`/`authenticated`, extending
`shops_protected_columns_guard` (migration `20261110130000`) rather than adding a new mechanism:
`vapi_assistant_id`, `vapi_phone_number_id`, `voice_live`, `voice_test_called_at`,
`vapi_server_secret_enc`. Owner UI actions that legitimately set them must go through a
session-derived, owner-reverified server seam that then writes with the service client.

## Audit (done, 2026-11-15)

Schema: `20260512100000` (vapi_assistant_id + partial unique index), `20260611100000`
(voice_live, voice_test_called_at, vapi_phone_number_id, vapi_stale, vapi_server_secret_enc,
voice_minutes_budget). Only the guard migration protects any of the voice columns
(vapi_stale true->false, voice_minutes_budget). Already protected neighbours: voice_addon,
voice_minutes_budget, number columns. Owner-configurable and deliberately left alone:
`voice_config` (form answers), `credit_limit`.

Writers found:

| Column | Writer | Client today | Plan |
| --- | --- | --- | --- |
| vapi_assistant_id | `syncVoiceAssistant` (voice-provider.ts) | service (callers pass service) | unchanged |
| vapi_assistant_id | `saveVapiAssistantId` (actions/shop.ts) | OWNER SESSION, no callers | delete (dead forging seam) |
| vapi_phone_number_id | `attachVoiceNumber` | service | unchanged |
| vapi_server_secret_enc | `syncVoiceAssistant` | service | unchanged |
| voice_test_called_at | `startVoiceTestCall` (via `runVoiceTestCall`) | service | unchanged |
| voice_live | `setVoiceLive` (actions/voice-builder.ts) | OWNER SESSION | service client after owner re-verify + gate |
| voice_live=false | stripe webhook | service | unchanged |

## State

- [x] Reading done (AGENTS.md, AI_WORK_LOG, five governing docs).
- [x] Audit table above.
- [ ] Reproduce the forge primitive on a disposable local Supabase stack (BEFORE evidence).
- [ ] Migration extending the guard; defaults on INSERT; UPDATE transitions.
- [ ] Move `setVoiceLive` to a service-client seam; delete `saveVapiAssistantId`.
- [ ] Integration tests (cross-tenant, service writers, rollback), unit tests, upgrade verifier.
- [ ] typecheck, lint, build, focused unit + integration.
- [ ] AI_WORK_LOG entry, rebase on origin/main, push, non-draft PR (do not merge).

## Commands

Use the isolated runner (`node scripts/isolated-check.mjs ...`) on a dedicated disposable stack;
never another agent's stack. See `scripts/verify-shops-protected-columns-migration.py` for the
rolled-back-transaction upgrade pattern.

## Next step

Reproduce the primitive (owner JWT PostgREST PATCH of `voice_live` / `vapi_assistant_id`) on a fresh local stack.
