# Local dev — environment & walkthrough stack

**Standing rule (2026-07-02): no local process may touch production by accident.
Local dev runs against the local Supabase stack. Never mint sessions against
prod; UI walkthroughs use the local stack.**

## Environment files

| File | Contents | Loaded by |
|---|---|---|
| `.env.local` | LOCAL supabase stack (127.0.0.1:54321) + platform model keys (Anthropic/OpenAI) + `ENCRYPTION_KEY` | Next dev/build, eval suite |
| `.env.production.pull` | Full production snapshot (Vercel `production` env) | **Nothing.** Deliberately unloaded — reference only |

- Refresh the prod snapshot: `npx vercel env pull .env.production.pull`
- Both files are gitignored (`.env*`).
- Deployed environments get their env from Vercel — this split changes local
  behavior only.

## Local Supabase stack

```sh
supabase start          # from platform/ — applies supabase/migrations
```

One-time after a fresh `supabase db reset`/first start — the local stack lacks
hosted Supabase's default grants:

```sh
docker exec supabase_db_gradia-app psql -U postgres -d postgres -c \
  "GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
   GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
   GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role, authenticated;"
```

Keys shown by `supabase status` (publishable = anon, secret = service role).

**After pulling new migrations:** `supabase start` does NOT apply them to an
existing local volume — run `supabase migration up`, then **re-run the grant
block above** (grants only cover tables that existed when they ran; new
tables come up ungranted).

## Seeded walkthrough

Seed a dev owner + shop (idempotent), then sign in by minting a magic link
against the LOCAL stack only — see the L2 seed script pattern
(`admin.createUser` → shop insert → `admin.generateLink` → `verifyOtp` →
`sb-127-auth-token` cookie). Dev user: `dev@gradia.local`, shop
"Demo Detailing". Screenshots land in `_docs/redesign/screens/layer-N/`.
