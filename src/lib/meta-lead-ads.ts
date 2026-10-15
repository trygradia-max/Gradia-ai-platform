import { createHmac, timingSafeEqual } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"
import { recordLeadIntake, type LeadIntakeResult } from "@/lib/lead-intake"

/**
 * Meta Lead Ads webhook adapter.
 *
 * Verify the raw body, then parse, then record. The shop is the page
 * binding. A shop id in the body is only a claim: if it disagrees with
 * the binding, nothing is written.
 *
 * Follow-up: meta_graph_lead_field_retrieval. The leadgen webhook does
 * not carry name, phone, or email. This module does not call Graph and
 * does not invent those fields. field_data in the body is ignored.
 */

export const META_LEAD_ADS_PROVIDER = "meta_lead_ads"

const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/
const CREATED_UNIX = /^[0-9]{1,16}$/
const CREATED_ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/
const CHALLENGE = /^[A-Za-z0-9._-]{1,256}$/

export type MetaLeadgenEvent = {
  pageId: string
  formId: string
  leadgenId: string
  createdTime: string
  claimedShopId: string | null
}

export type MetaLeadAdsIntakeAcceptance =
  | { ok: true; results: LeadIntakeResult[] }
  | { ok: false; status: 403 | 404; error: string }

function configuredEnv(name: string): string | null {
  const value = process.env[name]
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Fail closed when META_APP_SECRET is unset. Never a hardcoded secret. */
export function metaLeadAdsAppSecret(): string | null {
  return configuredEnv("META_APP_SECRET")
}

/** Fail closed when META_WEBHOOK_VERIFY_TOKEN is unset. */
export function metaLeadAdsVerifyToken(): string | null {
  return configuredEnv("META_WEBHOOK_VERIFY_TOKEN")
}

function fixedEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * HMAC-SHA256 of the raw body, header `sha256=<hex>`. A missing secret,
 * a missing header, or a mismatch returns false and the caller writes nothing.
 */
export function verifyMetaLeadAdsSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | null,
): boolean {
  const key = secret?.trim()
  if (!key) return false
  if (!signatureHeader) return false
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim())
  const hex = match?.[1]
  if (!hex) return false
  const provided = hex.toLowerCase()
  const expected = createHmac("sha256", key).update(rawBody, "utf8").digest("hex")
  return fixedEqual(expected, provided)
}

/**
 * Echo hub.challenge only when hub.mode is subscribe and the verify token
 * matches. An unset token does not echo the challenge.
 */
export function readMetaHubChallenge(input: {
  mode: string | null
  verifyToken: string | null
  challenge: string | null
  configuredToken: string | null
}): { ok: true; challenge: string } | { ok: false } {
  const configured = input.configuredToken?.trim()
  if (!configured) return { ok: false }
  if (input.mode !== "subscribe") return { ok: false }
  const provided = input.verifyToken?.trim()
  if (!provided || !fixedEqual(configured, provided)) return { ok: false }
  if (!input.challenge || !CHALLENGE.test(input.challenge)) return { ok: false }
  return { ok: true, challenge: input.challenge }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    const text = String(value)
    return EVENT_ID.test(text) ? text : null
  }
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return EVENT_ID.test(trimmed) ? trimmed : null
}

function readCreatedTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    const text = String(value)
    return CREATED_UNIX.test(text) ? text : null
  }
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (CREATED_UNIX.test(trimmed) || CREATED_ISO.test(trimmed)) return trimmed
  return null
}

function readShopClaim(record: Record<string, unknown>): { ok: true; shopId: string | null } | { ok: false } {
  if (!Object.prototype.hasOwnProperty.call(record, "shop_id")) {
    return { ok: true, shopId: null }
  }
  const value = record.shop_id
  if (typeof value !== "string") return { ok: false }
  const parsed = z.string().uuid().safeParse(value.trim())
  if (!parsed.success) return { ok: false }
  return { ok: true, shopId: parsed.data }
}

function oneClaim(
  claims: Array<{ ok: true; shopId: string | null } | { ok: false }>,
): string | null | "bad" {
  const ids: string[] = []
  for (const claim of claims) {
    if (!claim.ok) return "bad"
    if (claim.shopId) ids.push(claim.shopId)
  }
  const distinct = new Set(ids.map((id) => id.toLowerCase()))
  if (distinct.size > 1) return "bad"
  return ids[0] ?? null
}

/**
 * Leadgen changes only. Extra Meta keys (ad_id, field_data) are dropped.
 * A malformed leadgen change fails the whole body so nothing is written.
 */
export function parseMetaLeadgenBody(body: unknown):
  | { ok: true; events: MetaLeadgenEvent[] }
  | { ok: false } {
  const root = asRecord(body)
  if (!root || root.object !== "page" || !Array.isArray(root.entry)) return { ok: false }
  const rootClaim = readShopClaim(root)
  if (!rootClaim.ok) return { ok: false }
  const events: MetaLeadgenEvent[] = []
  for (const entryValue of root.entry) {
    const entry = asRecord(entryValue)
    if (!entry || !Array.isArray(entry.changes)) return { ok: false }
    const entryClaim = readShopClaim(entry)
    if (!entryClaim.ok) return { ok: false }
    const entryPage = readId(entry.id)
    for (const changeValue of entry.changes) {
      const change = asRecord(changeValue)
      if (!change) return { ok: false }
      if (change.field !== "leadgen") continue
      const value = asRecord(change.value)
      if (!value) return { ok: false }
      const valueClaim = readShopClaim(value)
      if (!valueClaim.ok) return { ok: false }
      const claimedShopId = oneClaim([rootClaim, entryClaim, valueClaim])
      if (claimedShopId === "bad") return { ok: false }
      const valuePage = readId(value.page_id)
      if (entryPage && valuePage && entryPage !== valuePage) return { ok: false }
      const pageId = valuePage ?? entryPage
      const formId = readId(value.form_id)
      const leadgenId = readId(value.leadgen_id)
      const createdTime = readCreatedTime(value.created_time)
      if (!pageId || !formId || !leadgenId || !createdTime) return { ok: false }
      events.push({ pageId, formId, leadgenId, createdTime, claimedShopId })
    }
  }
  return { ok: true, events }
}

export function chooseMetaLeadPageShop(
  shopIds: readonly string[],
  claimedShopId: string | null,
): { ok: true; shopId: string } | { ok: false; status: 403 | 404; error: string } {
  if (shopIds.length === 0) {
    return { ok: false, status: 404, error: "Page is not bound." }
  }
  if (shopIds.length !== 1) {
    return { ok: false, status: 403, error: "Page binding is not unique." }
  }
  const shopId = shopIds[0]
  if (!shopId || !z.string().uuid().safeParse(shopId).success) {
    return { ok: false, status: 403, error: "Page binding is not unique." }
  }
  if (claimedShopId && claimedShopId.toLowerCase() !== shopId.toLowerCase()) {
    return { ok: false, status: 403, error: "Shop binding does not match." }
  }
  return { ok: true, shopId }
}

export function metaLeadAdsIntakeInput(input: {
  shopId: string
  pageId: string
  formId: string
  leadgenId: string
  createdTime: string
  receivedAt: string
}) {
  const leadgenId = input.leadgenId.trim()
  return {
    shopId: input.shopId,
    channel: "meta" as const,
    provider: META_LEAD_ADS_PROVIDER,
    providerEventId: leadgenId,
    receivedAt: input.receivedAt,
    evidenceRef: null,
    threadKey: null,
    payload: {
      page_id: input.pageId.trim(),
      form_id: input.formId.trim(),
      leadgen_id: leadgenId,
      created_time: input.createdTime.trim(),
    },
  }
}

async function shopsForPage(db: SupabaseClient, pageId: string): Promise<string[]> {
  const { data, error } = await db
    .from("meta_lead_page_bindings")
    .select("shop_id")
    .eq("page_id", pageId)
  if (error) throw new Error("Page binding lookup failed")
  return (data ?? []).map((row) => {
    const shopId = (row as { shop_id?: unknown }).shop_id
    if (typeof shopId !== "string") throw new Error("Page binding lookup failed")
    return shopId
  })
}

/**
 * Resolve every page before any insert. Unknown, ambiguous, or a
 * disagreeing body shop id returns without calling record_lead_intake.
 * The same leadgen id stays one envelope; the first payload wins.
 */
export async function acceptMetaLeadAdsIntake(
  db: SupabaseClient,
  events: readonly MetaLeadgenEvent[],
  receivedAt: string,
): Promise<MetaLeadAdsIntakeAcceptance> {
  const resolved: Array<{ event: MetaLeadgenEvent; shopId: string }> = []
  for (const event of events) {
    const choice = chooseMetaLeadPageShop(
      await shopsForPage(db, event.pageId),
      event.claimedShopId,
    )
    if (!choice.ok) return choice
    resolved.push({ event, shopId: choice.shopId })
  }
  const results: LeadIntakeResult[] = []
  for (const item of resolved) {
    try {
      results.push(await recordLeadIntake(db, metaLeadAdsIntakeInput({
        shopId: item.shopId,
        pageId: item.event.pageId,
        formId: item.event.formId,
        leadgenId: item.event.leadgenId,
        createdTime: item.event.createdTime,
        receivedAt,
      })))
    } catch (err) {
      const message = err instanceof Error ? err.message : ""
      if (message.includes("another shop") || message.includes("unavailable")) {
        return { ok: false, status: 403, error: "Shop binding does not match." }
      }
      throw err
    }
  }
  return { ok: true, results }
}
