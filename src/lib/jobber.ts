/**
 * Jobber API primitives. Each shop connects their own Jobber account
 * via OAuth; we store the access + refresh tokens encrypted at rest
 * and refresh transparently when they expire.
 *
 * Auth model:
 *   - Authorization code flow at https://api.getjobber.com/api/oauth/authorize
 *   - Token exchange at https://api.getjobber.com/api/oauth/token
 *   - Access tokens are short-lived (~1h); refresh tokens long-lived
 *
 * Pilot scope: we only call mutations that *push* (create client,
 * create request/quote) from Gradia → Jobber. No inbound webhook
 * yet — the shop's Jobber dashboard remains the source of truth for
 * job state.
 *
 * Docs: https://developer.getjobber.com/
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { encryptSecret, tryDecryptSecret } from "@/lib/crypto"
import type { ShopRow } from "@/lib/types/database"

const JOBBER_AUTHORIZE_URL = "https://api.getjobber.com/api/oauth/authorize"
const JOBBER_TOKEN_URL = "https://api.getjobber.com/api/oauth/token"
const JOBBER_GRAPHQL_URL = "https://api.getjobber.com/api/graphql"
const JOBBER_API_VERSION = "2024-04-08"
const EXPIRY_BUFFER_MS = 60 * 1000 // refresh 1 min before nominal expiry

export class JobberError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
    this.name = "JobberError"
  }
}

export type JobberTokenSet = {
  accessToken: string
  refreshToken: string | null
  /** Absolute ISO timestamp when the access token nominally expires. */
  expiresAt: string
}

function jobberClientId(): string {
  const v = process.env.JOBBER_CLIENT_ID?.trim()
  if (!v) throw new JobberError(500, "JOBBER_CLIENT_ID not configured")
  return v
}

function jobberClientSecret(): string {
  const v = process.env.JOBBER_CLIENT_SECRET?.trim()
  if (!v) throw new JobberError(500, "JOBBER_CLIENT_SECRET not configured")
  return v
}

/**
 * Builds the URL we redirect the operator to in order to grant
 * Gradia access to their Jobber account. The `state` is verified
 * back in the callback to defeat CSRF.
 */
export function buildAuthorizeUrl(input: {
  redirectUri: string
  state: string
  /** Space-separated; pilot needs clients + requests + quotes. */
  scope?: string
}): string {
  const scope =
    input.scope ??
    [
      "read_clients",
      "write_clients",
      "read_requests",
      "write_requests",
      "read_quotes",
      "write_quotes",
    ].join(" ")
  const url = new URL(JOBBER_AUTHORIZE_URL)
  url.searchParams.set("client_id", jobberClientId())
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("state", input.state)
  url.searchParams.set("scope", scope)
  return url.toString()
}

type RawTokenResponse = {
  access_token?: string
  refresh_token?: string | null
  expires_in?: number
  token_type?: string
  error?: string
  error_description?: string
}

async function postTokenForm(body: URLSearchParams): Promise<JobberTokenSet> {
  const res = await fetch(JOBBER_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  })
  const raw = (await res.json()) as RawTokenResponse
  if (!res.ok || raw.error || !raw.access_token) {
    throw new JobberError(
      res.status,
      raw.error_description || raw.error || "Jobber token request failed",
      raw.error
    )
  }
  const expiresInSec =
    typeof raw.expires_in === "number" && raw.expires_in > 0
      ? raw.expires_in
      : 3600
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
  }
}

export async function exchangeAuthorizationCode(input: {
  code: string
  redirectUri: string
}): Promise<JobberTokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: jobberClientId(),
    client_secret: jobberClientSecret(),
  })
  return postTokenForm(body)
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<JobberTokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: jobberClientId(),
    client_secret: jobberClientSecret(),
  })
  return postTokenForm(body)
}

/**
 * Returns a usable access token for the given shop, refreshing
 * (and persisting the new tokens) when the stored one is within
 * EXPIRY_BUFFER_MS of expiry. Throws JobberError when the shop
 * isn't connected or refresh fails — callers should treat that as
 * "tell the operator to reconnect in Settings."
 */
export async function getAccessTokenForShop(
  supabase: SupabaseClient,
  shop: Pick<
    ShopRow,
    | "id"
    | "jobber_access_token_enc"
    | "jobber_refresh_token_enc"
    | "jobber_token_expires_at"
  >
): Promise<string> {
  const access = tryDecryptSecret(shop.jobber_access_token_enc)
  const refresh = tryDecryptSecret(shop.jobber_refresh_token_enc)
  if (!access) {
    throw new JobberError(401, "Jobber not connected for this shop.")
  }

  const expiresAtMs = shop.jobber_token_expires_at
    ? new Date(shop.jobber_token_expires_at).getTime()
    : 0
  const stale = !expiresAtMs || expiresAtMs - Date.now() < EXPIRY_BUFFER_MS

  if (!stale) return access
  if (!refresh) {
    throw new JobberError(
      401,
      "Jobber token expired and no refresh token — reconnect Jobber in Settings."
    )
  }

  const next = await refreshAccessToken(refresh)
  // Persist before returning so concurrent calls share the new token.
  const { error } = await supabase
    .from("shops")
    .update({
      jobber_access_token_enc: encryptSecret(next.accessToken),
      jobber_refresh_token_enc: next.refreshToken
        ? encryptSecret(next.refreshToken)
        : shop.jobber_refresh_token_enc,
      jobber_token_expires_at: next.expiresAt,
    })
    .eq("id", shop.id)
  if (error) {
    console.error("[jobber] failed to persist refreshed token:", error)
  }
  return next.accessToken
}

type GraphQLError = { message: string; extensions?: Record<string, unknown> }

/**
 * Thin GraphQL caller. Returns `data` on success, throws JobberError
 * on transport or GraphQL errors. Callers shape the query.
 */
export async function jobberGraphQL<T>(input: {
  accessToken: string
  query: string
  variables?: Record<string, unknown>
}): Promise<T> {
  const res = await fetch(JOBBER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-JOBBER-GRAPHQL-VERSION": JOBBER_API_VERSION,
    },
    body: JSON.stringify({
      query: input.query,
      variables: input.variables ?? {},
    }),
  })
  const json = (await res.json()) as {
    data?: T
    errors?: GraphQLError[]
  }
  if (!res.ok || json.errors?.length) {
    const first = json.errors?.[0]
    throw new JobberError(
      res.status,
      first?.message ?? `Jobber GraphQL failed (${res.status})`
    )
  }
  if (!json.data) {
    throw new JobberError(500, "Jobber GraphQL returned no data")
  }
  return json.data
}

type AccountInfo = { id: string; name: string }

/**
 * `account { id name }` — verifies the token and gives us a name to
 * show in the settings card after a fresh connect.
 */
export async function fetchAccountInfo(
  accessToken: string
): Promise<AccountInfo> {
  const data = await jobberGraphQL<{
    account: { id: string; name: string } | null
  }>({
    accessToken,
    query: `query { account { id name } }`,
  })
  if (!data.account) {
    throw new JobberError(404, "Jobber account not visible to this token.")
  }
  return { id: data.account.id, name: data.account.name }
}
