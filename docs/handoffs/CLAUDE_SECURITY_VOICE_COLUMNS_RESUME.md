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

## State (2026-11-15, final)

- [x] Reading done (AGENTS.md, AI_WORK_LOG, five governing docs; Next `use server` doc).
- [x] Audit table above.
- [x] Primitive reproduced on private stack `gradia-voice-columns` (port 59431) before the fix.
- [x] Migration `20261115120000_shops_voice_columns_guard.sql` (extends the existing guard in place).
- [x] `setVoiceLive` -> `src/lib/voice-live.ts` service seam; `saveVapiAssistantId` deleted.
- [x] Integration (`shops-voice-columns.int.test.ts`, extended `shops-protected-columns.int.test.ts`), unit
      (`voice-live.test.ts`), upgrade verifier, read-only preflight SQL.
- [x] Full integration 952, unit 2,679, tsc, eslint, offline build all green; rebased on origin/main `1ce68de`.
- [x] Work log entry appended; pushed; non-draft PR opened. DO NOT MERGE from this session.

Branch note: the first checkpoints were pushed to `claude/security-fix-remaining-voice-columns` before the final
rebase; force-push is not permitted, so the rebased history is on `claude/security-fix-voice-columns-rebased`
and the PR is opened from that branch. The older branch is superseded and can be deleted by a human.

Remaining for a human: merge decision; run `scripts/preflight-voice-columns.sql` read-only against any
real database before release; CI runs the integration files on its own stack.

## Local-only note

The private stack is not in the repo allowlists (`eval/integration/_db.ts`, `eval/_network-guard.ts`), so to rerun
the integration files there, add `gradia-voice-columns` / `http://127.0.0.1:59431` to both locally and revert
before committing. The stack lives in `.local-tools/voice-columns` (git-excluded); `supabase --workdir
.local-tools/voice-columns stop --no-backup` removes it.

## Commands

Use the isolated runner (`node scripts/isolated-check.mjs ...`) on a dedicated disposable stack;
never another agent's stack. See `scripts/verify-shops-protected-columns-migration.py` for the
rolled-back-transaction upgrade pattern.

## Next step

Reproduce the primitive (owner JWT PostgREST PATCH of `voice_live` / `vapi_assistant_id`) on a fresh local stack.
