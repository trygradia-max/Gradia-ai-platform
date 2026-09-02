import type { ShopRow } from "@/lib/types/database"

/**
 * Connection truth — ONE predicate set for "is this integration connected?"
 * (UX-001, scope item 1).
 *
 * Before this module the app carried three different predicates for the same
 * question: Home/BI read the credential pair (`aurinko_access_token_enc` +
 * `aurinko_account_id`), the Settings tiles and the Email card read the display
 * field `aurinko_account_email`, and the agent runtime read the token alone.
 * The Aurinko account fetch returns `email` as optional (`aurinko.ts`
 * `obj.email ?? null`), so a shop can hold a working credential pair with a
 * null display email — Home says "Live", Settings says "Connect Gmail". That is
 * the founder repro of 2026-09-01. The fix is structural: truth comes from the
 * credentials, identity is a separate, optional display value.
 *
 * Pure: takes the already-resolved shop row (tenant scoping happens in
 * `requireShop()` upstream) and never reads the environment. E02-02 later
 * moves these predicates onto `shop_connections`; this helper is the seam it
 * replaces.
 */

export type ConnectionKey = "email" | "calendar" | "sms" | "voice" | "crm"

export type ConnectionState = {
  /** The truth: credentials that can actually do the work are on file. */
  connected: boolean
  /** Display-only identity (mailbox, phone number, CRM account). May be null
   *  even when connected — never use it as the predicate. */
  identity: string | null
}

export type ConnectionStatus = Record<ConnectionKey, ConnectionState>

/** The subset of `shops` the predicates read — accepts any superset row. */
export type ConnectionShopFields = Partial<
  Pick<
    ShopRow,
    | "aurinko_access_token_enc"
    | "aurinko_account_id"
    | "aurinko_account_email"
    | "twilio_phone_number"
    | "vapi_assistant_id"
    | "jobber_access_token_enc"
    | "jobber_account_id"
    | "jobber_account_name"
  >
>

function present(value: string | number | null | undefined): boolean {
  if (value == null) return false
  if (typeof value === "number") return Number.isFinite(value)
  return value.trim().length > 0
}

function textOrNull(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null
}

export function connectionStatus(
  shop: ConnectionShopFields | null | undefined
): ConnectionStatus {
  // Email + calendar share one OAuth grant (same token, same account), so they
  // share one predicate — the calendar can never be "on" while email is "off".
  const mailbox = Boolean(
    shop && present(shop.aurinko_access_token_enc) && present(shop.aurinko_account_id)
  )
  const sms = Boolean(shop && present(shop.twilio_phone_number))
  const voice = Boolean(shop && present(shop.vapi_assistant_id))
  // CRM truth is the stored token; the account name is what the owner sees.
  const crm = Boolean(shop && present(shop.jobber_access_token_enc))

  return {
    email: { connected: mailbox, identity: textOrNull(shop?.aurinko_account_email) },
    calendar: { connected: mailbox, identity: mailbox ? "Google Calendar" : null },
    sms: { connected: sms, identity: textOrNull(shop?.twilio_phone_number) },
    // The assistant id is an internal handle, not something to print.
    voice: { connected: voice, identity: null },
    crm: { connected: crm, identity: textOrNull(shop?.jobber_account_name) },
  }
}

/**
 * Server-side availability — is the integration wired for this deployment at
 * all? Drives the NOT AVAILABLE tile state (UX-001 scope item 2). Reads
 * presence only, never values; one place instead of the per-page copies the
 * Settings and Onboarding pages used to keep.
 */
export type IntegrationAvailability = Record<ConnectionKey, boolean>

function envHas(name: string): boolean {
  return Boolean(process.env[name]?.trim())
}

export function integrationAvailability(): IntegrationAvailability {
  const aurinko = envHas("AURINKO_CLIENT_ID") && envHas("AURINKO_CLIENT_SECRET")
  return {
    email: aurinko,
    calendar: aurinko,
    sms: envHas("TWILIO_ACCOUNT_SID") && envHas("TWILIO_AUTH_TOKEN"),
    voice: envHas("VAPI_API_KEY"),
    crm: envHas("JOBBER_CLIENT_ID") && envHas("JOBBER_CLIENT_SECRET"),
  }
}
