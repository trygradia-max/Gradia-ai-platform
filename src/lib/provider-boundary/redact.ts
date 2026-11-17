/**
 * Provider boundary — PII / secret / identifier minimization for model input.
 *
 * Everything that reaches a model request goes through `prepareForModel`. The
 * model never needs a phone number, an email address, a provider id, a tenant
 * id, a header or a credential to classify an inquiry or write a reply; the
 * route owns recipients and identifiers and attaches them in code afterwards.
 */

import { boundedExcerpt, defang, normalizeForProposal } from "./text"

export const REDACTION_TOKENS = ["[email]", "[phone]", "[link]", "[id]", "[secret]", "[header removed]"] as const

const HEADER_LINE =
  /^[ \t]*(received|message-id|return-path|dkim-signature|authentication-results|arc-[\w-]+|x-[\w-]+|reply-to|delivered-to|in-reply-to|references|content-[\w-]+|mime-version|list-[\w-]+|sender|from|to|cc|bcc|date|subject)[ \t]*:.*$/gim

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\bwhsec_[A-Za-z0-9]{8,}\b/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:api[_-]?key|secret|token|password|passwd|authorization)\s*[:=]\s*\S{6,}/gi,
]

/** Provider / tenant identifiers: Twilio SIDs, Stripe-style ids, UUIDs, long hex. */
const ID_PATTERNS: RegExp[] = [
  /\b(?:SM|MM|AC|CA|PN|MG|SK|PK|RE|CH|KS|QT|ZN)[0-9a-f]{32}\b/gi,
  /\b(?:cus|pi|sub|in|ch|price|prod|acct|evt|re|pm|pmt|seti|cs|whsec|txn|ba|card|src)_[A-Za-z0-9]{8,}\b/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b[0-9a-f]{24,}\b/gi,
]

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
const URL_LIKE = /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"')]+/gi
/** 10+ digits, optionally separated by space . - ( ) and an optional leading +. */
const PHONE = /(?<![\w])(?:\+?\d[\d\s().-]{7,}\d)(?![\w])/g

function redactPhones(text: string): string {
  return text.replace(PHONE, (m) => (m.replace(/\D/g, "").length >= 10 ? "[phone]" : m))
}

/** Redact PII, identifiers, headers and secrets from already-normalized text. */
export function redactForModel(text: string, known: readonly (string | null | undefined)[] = []): string {
  let t = text
  for (const k of known) {
    const v = k?.trim()
    if (v && v.length >= 4) t = t.split(v).join("[id]")
  }
  for (const re of SECRET_PATTERNS) t = t.replace(re, "[secret]")
  t = t.replace(HEADER_LINE, "[header removed]")
  t = t.replace(EMAIL, "[email]")
  t = t.replace(URL_LIKE, "[link]")
  for (const re of ID_PATTERNS) t = t.replace(re, "[id]")
  t = redactPhones(t)
  return t
}

/** First phone-like number found in raw text, as a lightly normalized string; "" if none. Deterministic, code-side. */
export function extractPhoneCandidate(raw: string): string {
  const m = normalizeForProposal(raw, 20_000).match(PHONE)
  if (!m) return ""
  for (const candidate of m) {
    const digits = candidate.replace(/\D/g, "")
    if (digits.length >= 10 && digits.length <= 15) {
      return candidate.trim().startsWith("+") ? `+${digits}` : digits
    }
  }
  return ""
}

const QUOTE_BOUNDARIES: RegExp[] = [
  /^On .{5,240}wrote:\s*$/m,
  /^-{2,}\s*(?:Original|Forwarded) Message\s*-{2,}/im,
  /^_{8,}\s*$/m,
  /^From:.{0,200}\n(?:Sent|Date):/im,
]
const SIGNATURE_BOUNDARY = /^--\s*$/m

/** Drop quoted reply chains (and optionally the signature block) from an email body. */
export function stripQuotedReplies(body: string, options: { keepSignature?: boolean } = {}): string {
  const boundaries = options.keepSignature ? QUOTE_BOUNDARIES : [...QUOTE_BOUNDARIES, SIGNATURE_BOUNDARY]
  let cut = body.length
  for (const re of boundaries) {
    const idx = body.search(re)
    if (idx >= 0 && idx < cut) cut = idx
  }
  return body
    .slice(0, cut)
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
}

/** Drop quoted reply chains and signature blocks (unnecessary context) from an email body. */
export function stripQuotedAndSignature(body: string): string {
  return stripQuotedReplies(body)
}

export type ModelTextOptions = {
  maxLength: number
  singleLine?: boolean
  /** Strip quoted replies / signatures (email bodies). */
  stripQuoted?: boolean
  /** Exact strings (tenant/customer ids) to remove wherever they occur. */
  known?: readonly (string | null | undefined)[]
}

/**
 * Full model-input path for one untrusted field: normalize → (strip quoted) →
 * redact → defang fences → bounded excerpt. Order matters: normalization first
 * so invisible characters cannot split a pattern the redactors look for.
 */
export function prepareForModel(raw: unknown, options: ModelTextOptions): string {
  let t = normalizeForProposal(raw, 200_000, { singleLine: options.singleLine })
  if (options.stripQuoted) t = stripQuotedAndSignature(t)
  t = redactForModel(t, options.known)
  t = defang(t)
  t = normalizeForProposal(t, Number.MAX_SAFE_INTEGER, { singleLine: options.singleLine })
  return boundedExcerpt(t, options.maxLength)
}
