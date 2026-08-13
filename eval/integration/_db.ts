import { createClient, type SupabaseClient } from "@supabase/supabase-js"

/**
 * Integration test harness — talks to a REAL Supabase (the local stack in CI),
 * so the approval engine's atomic claim, dispatch, and rollback run against
 * actual Postgres, not a mock.
 *
 * Gated: these only run when INTEGRATION=1 AND the test DB env is present
 * (set by the ci-integration job after `supabase start`). Locally, with no
 * Docker, they self-skip — `npm test` and `npm run eval` stay green.
 *
 * Fixtures use supabase-js only: the admin API mints the auth.users row the
 * shop FK needs; the service-role client (bypasses RLS) does the rest.
 */
const URL = process.env.SUPABASE_TEST_URL
const KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY
const ANON = process.env.SUPABASE_TEST_ANON_KEY

export const INTEGRATION =
  process.env.INTEGRATION === "1" && Boolean(URL) && Boolean(KEY)

/** Permission tests additionally need the anon key (owner-session client). */
export const INTEGRATION_WITH_SESSION = INTEGRATION && Boolean(ANON)

export function serviceClient(): SupabaseClient {
  if (!URL || !KEY) {
    throw new Error("SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_ROLE_KEY not set")
  }
  return createClient(URL, KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Bare anon client — the unauthenticated PostgREST surface. */
export function anonClient(): SupabaseClient {
  if (!URL || !ANON) {
    throw new Error("SUPABASE_TEST_URL / SUPABASE_TEST_ANON_KEY not set")
  }
  return createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * A real signed-in OWNER session client (anon key + password sign-in) — what
 * the browser/PostgREST surface actually is. Used by RLS permission tests;
 * the seeded user needs a password (see seedShop's password option).
 */
export async function ownerSessionClient(
  email: string,
  password: string
): Promise<SupabaseClient> {
  const client = anonClient()
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`ownerSessionClient: sign-in failed: ${error.message}`)
  return client
}

export type Seeded = {
  ownerId: string
  shopId: string
  serviceId: string
  email: string
}

/** Mint an auth user + shop + one service. Returns the ids the tests need.
 *  Pass a password when the test needs a real owner SESSION client
 *  (RLS permission tests). */
export async function seedShop(
  sb: SupabaseClient,
  opts?: { password?: string }
): Promise<Seeded> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const email = `int-${stamp}@example.test`

  const { data: created, error: userErr } = await sb.auth.admin.createUser({
    email,
    email_confirm: true,
    ...(opts?.password ? { password: opts.password } : {}),
  })
  if (userErr || !created?.user) {
    throw new Error(`seed: createUser failed: ${userErr?.message}`)
  }
  const ownerId = created.user.id

  const { data: shop, error: shopErr } = await sb
    .from("shops")
    .insert({ name: "Integration Test Shop", owner_id: ownerId })
    .select("id")
    .single()
  if (shopErr || !shop) throw new Error(`seed: shop insert: ${shopErr?.message}`)

  const { data: svc, error: svcErr } = await sb
    .from("services")
    .insert({
      shop_id: shop.id,
      name: "Full Detail",
      price_cents: 25000,
      duration_minutes: 180,
    })
    .select("id")
    .single()
  if (svcErr || !svc) throw new Error(`seed: service insert: ${svcErr?.message}`)

  return { ownerId, shopId: shop.id, serviceId: svc.id, email }
}

/** Stage a pending_action exactly as the app would, ready for executeApproval. */
export async function stagePending(
  sb: SupabaseClient,
  shopId: string,
  requestedBy: string,
  actionType: string,
  payload: Record<string, unknown>
): Promise<string> {
  const { data, error } = await sb
    .from("pending_actions")
    .insert({
      shop_id: shopId,
      action_type: actionType,
      payload,
      requested_by: requestedBy,
    })
    .select("id")
    .single()
  if (error || !data) throw new Error(`stagePending: ${error?.message}`)
  return data.id as string
}

export async function getPending(
  sb: SupabaseClient,
  id: string
): Promise<{ status: string; result_id: string | null } | null> {
  const { data } = await sb
    .from("pending_actions")
    .select("status, result_id")
    .eq("id", id)
    .single()
  return (data as { status: string; result_id: string | null } | null) ?? null
}

export async function countLeads(
  sb: SupabaseClient,
  shopId: string
): Promise<number> {
  const { count } = await sb
    .from("leads")
    .select("*", { count: "exact", head: true })
    .eq("shop_id", shopId)
  return count ?? 0
}

/** Tear down: deleting the shop cascades pending_actions/leads/services; then
 *  drop the auth user. */
export async function cleanup(sb: SupabaseClient, seed: Seeded): Promise<void> {
  await sb.from("shops").delete().eq("id", seed.shopId)
  await sb.auth.admin.deleteUser(seed.ownerId)
}
