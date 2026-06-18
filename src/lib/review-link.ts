/**
 * The shop's public review link (NEXT-1). Stored in shops.settings (no
 * migration), surfaced to drafters so a review-request message always carries
 * the real link. The link is appended to copy DETERMINISTICALLY — never
 * model-generated — so the URL can't be corrupted or dropped.
 */

export const REVIEW_LINK_KEY = "review_link"

/** Read the shop's review link from its settings JSON, validated. */
export function getReviewLink(
  shop: { settings?: Record<string, unknown> | null } | null | undefined
): string | null {
  const raw = shop?.settings?.[REVIEW_LINK_KEY]
  if (typeof raw !== "string") return null
  return normalizeReviewLink(raw)
}

/** Trim + require an http(s) URL; returns null for anything else. */
export function normalizeReviewLink(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim()
  if (!v) return null
  if (!/^https?:\/\/\S+$/i.test(v)) return null
  return v
}

/** Append the link to an SMS body (idempotent — won't duplicate it). */
export function appendReviewLinkToSms(body: string, link: string): string {
  const b = body.trim()
  if (b.includes(link)) return b
  return `${b} ${link}`.trim()
}

/** Append the link to an email body as a footer line (idempotent). */
export function appendReviewLinkToEmail(body: string, link: string): string {
  const b = body.trim()
  if (b.includes(link)) return b
  return `${b}\n\nLeave us a review: ${link}`
}
