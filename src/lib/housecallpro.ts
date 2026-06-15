/**
 * Housecall Pro API primitives — the second CRM behind the
 * lib/crm-provider.ts seam. Each shop connects their own Housecall Pro
 * account via OAuth; we store the access + refresh tokens encrypted at
 * rest and refresh transparently when they expire.
 *
 * Auth model (mirrors Jobber):
 *   - Authorization code flow at https://api.housecallpro.com/oauth/authorize
 *   - Token exchange at https://api.housecallpro.com/oauth/token
 *   - Access tokens are short-lived; refresh tokens long-lived.
 *   - OAuth requires a registered partner app (HCP developer dashboard);
 *     the end shop must be on the MAX plan for API access.
 *
 * Pilot scope: we only call endpoints that *push* (find-or-create
 * customer, create job) from Gradia → Housecall Pro. No inbound webhook
 * yet — the shop's Housecall Pro dashboard remains the source of truth
 * for job state.
 *
 * NOTE on endpoint verification: the official docs (docs.housecallpro.com)
 * are a JS-rendered SPA. The shapes below follow the published OpenAPI
 * mirror. Four details could not be confirmed without a live sandbox key
 * and are marked TODO(verify) — confirm them against a real call before
 * relying on Housecall Pro in production:
 *   1. Whether resource paths carry a `/v1` prefix.
 *   2. The exact `schedule` object child keys on job create.
 *   3. `GET /companies` vs `/company` for account info.
 *   4. Whether `GET /customers` supports a dedicated phone/email filter
 *      (we use the generic `q` param, which IS confirmed).
 *
 * Docs: https://docs.housecallpro.com/docs/housecall-public-api
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { encryptSecret, tryDecryptSecret } from "@/lib/crypto"
import type { ShopRow } from "@/lib/types/database"

const HCP_AUTHORIZE_URL = "https://api.housecallpro.com/oauth/authorize"
const HCP_TOKEN_URL = "https://api.housecallpro.com/oauth/token"
const HCP_API_BASE = "https://api.housecallpro.com"
const EXPIRY_BUFFER_MS = 60 * 1000 // refresh 1 min before nominal expiry

export class HousecallProError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
    this.name = "HousecallProError"
  }
}

export type HousecallProTokenSet = {
  accessToken: string
  refreshToken: string | null
  /** Absolute ISO timestamp when the access token nominally expires. */
  expiresAt: string
}

function hcpClientId(): string {
  const v = process.env.HOUSECALLPRO_CLIENT_ID?.trim()
  if (!v) throw new HousecallProError(500, "HOUSECALLPRO_CLIENT_ID not configured")
  return v
}

function hcpClientSecret(): string {
  const v = process.env.HOUSECALLPRO_CLIENT_SECRET?.trim()
  if (!v)
    throw new HousecallProError(500, "HOUSECALLPRO_CLIENT_SECRET not configured")
  return v
}

/**
 * Builds the URL we redirect the operator to in order to grant Gradia
 * access to their Housecall Pro account. The `state` is verified back
 * in the callback to defeat CSRF.
 */
export function buildAuthorizeUrl(input: {
  redirectUri: string
  state: string
}): string {
  const url = new URL(HCP_AUTHORIZE_URL)
  url.searchParams.set("client_id", hcpClientId())
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("state", input.state)
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

async function postTokenForm(
  body: URLSearchParams
): Promise<HousecallProTokenSet> {
  const res = await fetch(HCP_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  })
  const raw = (await res.json()) as RawTokenResponse
  if (!res.ok || raw.error || !raw.access_token) {
    throw new HousecallProError(
      res.status,
      raw.error_description ||
        raw.error ||
        "Housecall Pro token request failed",
      raw.error
    )
  }
  // HCP doesn't document expires_in in published mirrors — read it when
  // present, otherwise fall back to a conservative 1h.
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
}): Promise<HousecallProTokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: hcpClientId(),
    client_secret: hcpClientSecret(),
  })
  return postTokenForm(body)
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<HousecallProTokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: hcpClientId(),
    client_secret: hcpClientSecret(),
  })
  return postTokenForm(body)
}

/**
 * Returns a usable access token for the given shop, refreshing (and
 * persisting the new tokens) when the stored one is within
 * EXPIRY_BUFFER_MS of expiry. Throws HousecallProError when the shop
 * isn't connected or refresh fails — callers should treat that as
 * "tell the operator to reconnect in Settings."
 */
export async function getAccessTokenForShop(
  supabase: SupabaseClient,
  shop: Pick<
    ShopRow,
    | "id"
    | "housecallpro_access_token_enc"
    | "housecallpro_refresh_token_enc"
    | "housecallpro_token_expires_at"
  >
): Promise<string> {
  const access = tryDecryptSecret(shop.housecallpro_access_token_enc)
  const refresh = tryDecryptSecret(shop.housecallpro_refresh_token_enc)
  if (!access) {
    throw new HousecallProError(401, "Housecall Pro not connected for this shop.")
  }

  const expiresAtMs = shop.housecallpro_token_expires_at
    ? new Date(shop.housecallpro_token_expires_at).getTime()
    : 0
  const stale = !expiresAtMs || expiresAtMs - Date.now() < EXPIRY_BUFFER_MS

  if (!stale) return access
  if (!refresh) {
    throw new HousecallProError(
      401,
      "Housecall Pro token expired and no refresh token — reconnect in Settings."
    )
  }

  const next = await refreshAccessToken(refresh)
  // Persist before returning so concurrent calls share the new token.
  const { error } = await supabase
    .from("shops")
    .update({
      housecallpro_access_token_enc: encryptSecret(next.accessToken),
      housecallpro_refresh_token_enc: next.refreshToken
        ? encryptSecret(next.refreshToken)
        : shop.housecallpro_refresh_token_enc,
      housecallpro_token_expires_at: next.expiresAt,
    })
    .eq("id", shop.id)
  if (error) {
    console.error("[housecallpro] failed to persist refreshed token:", error)
  }
  return next.accessToken
}

/**
 * Thin REST caller. Returns parsed JSON on success, throws
 * HousecallProError on transport errors. Callers shape path + body.
 */
async function hcpFetch<T>(input: {
  accessToken: string
  method: "GET" | "POST" | "PUT"
  path: string
  query?: Record<string, string>
  body?: unknown
}): Promise<T> {
  const url = new URL(`${HCP_API_BASE}${input.path}`)
  if (input.query) {
    for (const [k, v] of Object.entries(input.query)) {
      if (v != null && v !== "") url.searchParams.set(k, v)
    }
  }
  const res = await fetch(url.toString(), {
    method: input.method,
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
  })
  const text = await res.text()
  let json: unknown = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      // non-JSON error body
    }
  }
  if (!res.ok) {
    let msg = `Housecall Pro ${input.method} ${input.path} failed (${res.status})`
    if (json && typeof json === "object" && "message" in json) {
      const m = (json as { message?: unknown }).message
      if (typeof m === "string" && m) msg = m
    }
    throw new HousecallProError(res.status, msg)
  }
  return json as T
}

type CompanyInfo = { id: string; name: string }

/**
 * Verifies the token and gives us a name for the settings card after a
 * fresh connect.
 * TODO(verify): `/companies` (list) vs `/company` (singular) — the
 * OpenAPI mirror has `/companies`; the field for the display name is
 * assumed `name`.
 */
export async function fetchCompanyInfo(
  accessToken: string
): Promise<CompanyInfo> {
  const data = await hcpFetch<{
    companies?: { id: string; name?: string }[]
    id?: string
    name?: string
  }>({
    accessToken,
    method: "GET",
    path: "/companies",
  })
  // Tolerate either a list response or a single-object response.
  const first =
    Array.isArray(data.companies) && data.companies.length > 0
      ? data.companies[0]
      : data.id
        ? { id: data.id, name: data.name }
        : null
  if (!first?.id) {
    throw new HousecallProError(
      404,
      "Housecall Pro company not visible to this token."
    )
  }
  return { id: first.id, name: first.name ?? "Housecall Pro" }
}

// ---------- customer + job operations ----------

export type HousecallProCustomerInput = {
  firstName?: string | null
  lastName?: string | null
  company?: string | null
  email?: string | null
  /** E.164 or local; HCP stores it as mobile_number. */
  mobileNumber?: string | null
}

export type HousecallProCustomer = {
  id: string
  name: string
}

/**
 * Splits a single "Sam Rivera" name into first/last for HCP's shape.
 * Falls back to a company name for unnamed leads (HCP requires at least
 * one of first_name / last_name / company).
 */
export function nameToCustomerInput(
  fullName: string | null | undefined,
  fallback: string
): { firstName: string | null; lastName: string | null; company: string | null } {
  const trimmed = (fullName ?? "").trim()
  if (!trimmed) {
    return { firstName: null, lastName: null, company: fallback || "Lead" }
  }
  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: null, company: null }
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
    company: null,
  }
}

function displayName(c: {
  first_name?: string | null
  last_name?: string | null
  company?: string | null
}): string {
  const full = [c.first_name, c.last_name].filter(Boolean).join(" ").trim()
  return full || c.company || "Customer"
}

type RawCustomer = {
  id: string
  first_name?: string | null
  last_name?: string | null
  company?: string | null
}

/**
 * Looks for an existing HCP customer by phone OR email via the generic
 * `q` search param (confirmed param; a dedicated phone/email filter is
 * unverified). Returns the first match, or null when nothing matches.
 */
export async function findCustomer(input: {
  accessToken: string
  phone?: string | null
  email?: string | null
}): Promise<HousecallProCustomer | null> {
  const term = (input.phone ?? input.email ?? "").trim()
  if (!term) return null
  const data = await hcpFetch<{ customers?: RawCustomer[] }>({
    accessToken: input.accessToken,
    method: "GET",
    path: "/customers",
    query: { q: term, page_size: "3" },
  })
  const first = data.customers?.[0]
  if (!first?.id) return null
  return { id: first.id, name: displayName(first) }
}

export async function createCustomer(input: {
  accessToken: string
  customerInput: HousecallProCustomerInput
}): Promise<HousecallProCustomer> {
  const body: Record<string, unknown> = {
    first_name: input.customerInput.firstName ?? undefined,
    last_name: input.customerInput.lastName ?? undefined,
    company: input.customerInput.company ?? undefined,
    email: input.customerInput.email ?? undefined,
    mobile_number: input.customerInput.mobileNumber ?? undefined,
    notifications_enabled: false,
  }
  const data = await hcpFetch<RawCustomer>({
    accessToken: input.accessToken,
    method: "POST",
    path: "/customers",
    body,
  })
  if (!data?.id) {
    throw new HousecallProError(400, "Housecall Pro customer create returned no id.")
  }
  return { id: data.id, name: displayName(data) }
}

/**
 * Find-or-create. Caller passes any identifiers we have; we look up by
 * phone (preferred) or email, and create if nothing matched.
 */
export async function findOrCreateCustomer(input: {
  accessToken: string
  customerInput: HousecallProCustomerInput
}): Promise<HousecallProCustomer> {
  const found = await findCustomer({
    accessToken: input.accessToken,
    phone: input.customerInput.mobileNumber,
    email: input.customerInput.email,
  })
  if (found) return found
  return createCustomer({
    accessToken: input.accessToken,
    customerInput: input.customerInput,
  })
}

export type HousecallProJobInput = {
  customerId: string
  /** Free-text summary surfaced on the HCP job. */
  description: string
  /** ISO datetime; mapped into the schedule block. */
  scheduledAt?: string | null
  /** ISO datetime end; defaults to +1h when omitted by the caller. */
  scheduledEnd?: string | null
}

/**
 * Creates a Housecall Pro job. Used after an operator approves a
 * book_appointment in Gradia so the shop has the visit in their primary
 * CRM, not just our dashboard + calendar.
 *
 * TODO(verify): the `schedule` object child keys (`scheduled_start` /
 * `scheduled_end` / `arrival_window`) and whether HCP accepts an
 * unscheduled job without an address_id. We send a nested `schedule`
 * object (the OpenAPI mirror's shape); confirm against a sandbox call.
 */
export async function createJob(input: {
  accessToken: string
  jobInput: HousecallProJobInput
}): Promise<{ id: string }> {
  const schedule = input.jobInput.scheduledAt
    ? {
        scheduled_start: input.jobInput.scheduledAt,
        scheduled_end:
          input.jobInput.scheduledEnd ??
          new Date(
            new Date(input.jobInput.scheduledAt).getTime() + 60 * 60 * 1000
          ).toISOString(),
        arrival_window: 0,
      }
    : undefined
  const body: Record<string, unknown> = {
    customer_id: input.jobInput.customerId,
    description: input.jobInput.description,
    work_status: schedule ? "scheduled" : "needs_scheduling",
    ...(schedule ? { schedule } : {}),
  }
  const data = await hcpFetch<{ id?: string }>({
    accessToken: input.accessToken,
    method: "POST",
    path: "/jobs",
    body,
  })
  if (!data?.id) {
    throw new HousecallProError(400, "Housecall Pro job create returned no id.")
  }
  return { id: data.id }
}
