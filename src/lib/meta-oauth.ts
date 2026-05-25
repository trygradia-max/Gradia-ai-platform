/**
 * Meta (Facebook + Instagram) OAuth wrapper — server-only.
 *
 * Replaces the manual paste-token onboarding for Instagram + Facebook
 * DMs. One "Connect via Facebook" click in Gradia → Meta OAuth dialog
 * → we exchange the code for a long-lived user token, list the user's
 * Pages, pick one (or let the operator pick if there are several), and
 * write the encrypted long-lived Page Access Token + IG Business
 * Account back to the shop row.
 *
 * Auth model: one global Meta App. Each shop OAuths into that app and
 * grants page-level access — no per-shop App registration needed.
 *
 * Docs:
 *   https://developers.facebook.com/docs/facebook-login/guides/access-tokens
 *   https://developers.facebook.com/docs/messenger-platform/instagram/get-started
 *   https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps
 */

const GRAPH_API_BASE = "https://graph.facebook.com/v22.0"
const OAUTH_DIALOG_BASE = "https://www.facebook.com/v22.0/dialog/oauth"

/**
 * Scopes the OAuth dialog requests. Tuned to the minimum we actually
 * use — adding scopes here triggers an Advanced Access review with
 * Meta, so we keep it tight.
 *
 *   pages_show_list           – list the Pages the user manages
 *   pages_messaging           – send + receive Page DMs
 *   pages_manage_metadata     – subscribe our app to a Page's webhook
 *   pages_read_engagement     – read Page name + metadata
 *   instagram_basic           – read connected IG account id/handle
 *   instagram_manage_messages – send + receive IG DMs
 *   business_management       – list Pages the user has business access to
 */
const SCOPES = [
  "pages_show_list",
  "pages_messaging",
  "pages_manage_metadata",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_manage_messages",
  "business_management",
].join(",")

/** Subscribed_fields on the Page to receive the DM webhook deliveries. */
const PAGE_WEBHOOK_FIELDS = [
  "messages",
  "messaging_postbacks",
  "message_deliveries",
  "message_reads",
].join(",")

export class MetaOAuthError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = "MetaOAuthError"
  }
}

function appId(): string {
  const v = process.env.META_APP_ID?.trim()
  if (!v) {
    throw new MetaOAuthError(500, "META_APP_ID is not configured")
  }
  return v
}

function appSecret(): string {
  const v = process.env.META_APP_SECRET?.trim()
  if (!v) {
    throw new MetaOAuthError(500, "META_APP_SECRET is not configured")
  }
  return v
}

/**
 * Builds the URL the operator's browser should be sent to to start
 * OAuth. `state` is our CSRF token, persisted as a HttpOnly cookie on
 * the start route and checked on the callback.
 */
export function buildAuthorizeUrl(input: {
  redirectUri: string
  state: string
}): string {
  const params = new URLSearchParams({
    client_id: appId(),
    redirect_uri: input.redirectUri,
    state: input.state,
    response_type: "code",
    scope: SCOPES,
    // Pre-select the "manage selected Pages" option so the operator
    // doesn't accidentally grant access to every Page they own.
    auth_type: "rerequest",
  })
  return `${OAUTH_DIALOG_BASE}?${params.toString()}`
}

type RawTokenResponse = {
  access_token?: string
  token_type?: string
  expires_in?: number
  error?: { message?: string; code?: number }
}

/**
 * Exchanges the OAuth code for a short-lived user access token.
 * The short-lived token is then immediately upgraded to a 60-day
 * long-lived token via exchangeForLongLivedUserToken.
 */
export async function exchangeCodeForUserToken(input: {
  code: string
  redirectUri: string
}): Promise<string> {
  const url = new URL(`${GRAPH_API_BASE}/oauth/access_token`)
  url.searchParams.set("client_id", appId())
  url.searchParams.set("client_secret", appSecret())
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("code", input.code)

  const res = await fetch(url, { method: "GET" })
  const text = await res.text()
  if (!res.ok) {
    throw new MetaOAuthError(
      res.status,
      `Meta token exchange failed: ${text.slice(0, 300)}`
    )
  }
  let parsed: RawTokenResponse
  try {
    parsed = JSON.parse(text) as RawTokenResponse
  } catch {
    throw new MetaOAuthError(500, "Meta token response was not JSON")
  }
  if (!parsed.access_token) {
    throw new MetaOAuthError(
      500,
      parsed.error?.message ?? "No access_token in Meta response"
    )
  }
  return parsed.access_token
}

/**
 * Turns a short-lived user token (1 hour) into a long-lived one
 * (~60 days). The Page Access Tokens we extract from this long-lived
 * user token are themselves never expiring as long as the operator
 * keeps the FB account active.
 */
export async function exchangeForLongLivedUserToken(
  shortLivedToken: string
): Promise<string> {
  const url = new URL(`${GRAPH_API_BASE}/oauth/access_token`)
  url.searchParams.set("grant_type", "fb_exchange_token")
  url.searchParams.set("client_id", appId())
  url.searchParams.set("client_secret", appSecret())
  url.searchParams.set("fb_exchange_token", shortLivedToken)

  const res = await fetch(url, { method: "GET" })
  const text = await res.text()
  if (!res.ok) {
    throw new MetaOAuthError(
      res.status,
      `Meta long-lived exchange failed: ${text.slice(0, 300)}`
    )
  }
  let parsed: RawTokenResponse
  try {
    parsed = JSON.parse(text) as RawTokenResponse
  } catch {
    throw new MetaOAuthError(500, "Meta long-lived response was not JSON")
  }
  if (!parsed.access_token) {
    throw new MetaOAuthError(
      500,
      parsed.error?.message ?? "No access_token in long-lived response"
    )
  }
  return parsed.access_token
}

export type MetaPageCandidate = {
  /** Facebook Page id (numeric string). */
  pageId: string
  /** Human-readable Page name, e.g. "Apex Detailing". */
  pageName: string
  /** Long-lived Page Access Token (never-expiring for active users). */
  pageAccessToken: string
  /** IG Business Account id if the Page has an IG account attached. */
  instagramBusinessAccountId: string | null
  /** @handle for the IG account, no leading @. Best-effort. */
  instagramHandle: string | null
}

type RawPage = {
  id?: string
  name?: string
  access_token?: string
  instagram_business_account?: {
    id?: string
    username?: string
  }
}

type RawPagesResponse = {
  data?: RawPage[]
  paging?: { next?: string }
  error?: { message?: string }
}

/**
 * Lists every Page the user manages, with the long-lived Page Access
 * Token and (if present) the connected IG Business Account id +
 * username. Follows pagination — most operators have ≤ 5 pages.
 */
export async function listUserPages(
  userAccessToken: string
): Promise<MetaPageCandidate[]> {
  const out: MetaPageCandidate[] = []
  // Ask for the IG business account inline so we don't have to do
  // a second hop per page.
  let url: string | null =
    `${GRAPH_API_BASE}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100&access_token=${encodeURIComponent(userAccessToken)}`

  while (url) {
    const res: Response = await fetch(url, { method: "GET" })
    const text = await res.text()
    if (!res.ok) {
      throw new MetaOAuthError(
        res.status,
        `Meta pages list failed: ${text.slice(0, 300)}`
      )
    }
    let parsed: RawPagesResponse
    try {
      parsed = JSON.parse(text) as RawPagesResponse
    } catch {
      throw new MetaOAuthError(500, "Meta pages response was not JSON")
    }
    for (const p of parsed.data ?? []) {
      if (!p.id || !p.access_token) continue
      out.push({
        pageId: p.id,
        pageName: p.name?.trim() || "Untitled Page",
        pageAccessToken: p.access_token,
        instagramBusinessAccountId:
          p.instagram_business_account?.id ?? null,
        instagramHandle:
          p.instagram_business_account?.username ?? null,
      })
    }
    url = parsed.paging?.next ?? null
  }

  return out
}

/**
 * Subscribes our Meta App to receive webhook deliveries for this Page.
 * Without this, even with a valid Page Access Token, no inbound DMs
 * reach our webhook endpoint.
 *
 * Idempotent on Meta's side — calling again is a no-op if already
 * subscribed.
 */
export async function subscribePageWebhook(input: {
  pageId: string
  pageAccessToken: string
}): Promise<void> {
  const url = `${GRAPH_API_BASE}/${encodeURIComponent(input.pageId)}/subscribed_apps`
  const body = new URLSearchParams({
    subscribed_fields: PAGE_WEBHOOK_FIELDS,
    access_token: input.pageAccessToken,
  })
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new MetaOAuthError(
      res.status,
      `Meta subscribe failed: ${text.slice(0, 300)}`
    )
  }
}
