/**
 * Google Takeout .mbox parser for Customer Recovery (P8 / NEXT-3,
 * GRADIA_CUSTOMER_RECOVERY_SPEC §1.1). Pure + deterministic so it's fully
 * unit-tested without a file or DB.
 *
 * Two steps:
 *   parseMboxMessages — split the mbox into messages, parse the headers we need
 *     (Message-ID, From, Subject, Date, List-Unsubscribe) + the body.
 *   buildThreads — group messages into threads by normalized subject and mark
 *     owner participation from the shop's own addresses → PrefilterInput-shaped
 *     threads the pre-filter and extraction worker consume.
 *
 * Scope note: bodies are kept as-is. Full MIME/base64 decoding is a later
 * refinement; Takeout personal mail is overwhelmingly text/plain, and the
 * pre-filter + low-confidence worker scoring absorb the noisy minority.
 */

import type { PrefilterInput } from "@/lib/recovery/prefilter"

export type MboxMessage = {
  messageId: string | null
  /** Raw From header value (display + address). */
  from: string
  /** Parsed sender email, lowercased. */
  fromEmail: string
  subject: string
  /** ISO timestamp, or null when the Date header is missing/unparseable. */
  date: string | null
  hasListUnsubscribe: boolean
  body: string
}

/** A grouped thread: PrefilterInput fields + the body the worker extracts from. */
export type RecoveryThread = PrefilterInput & {
  date: string | null
  body: string
}

const MAX_THREAD_BODY = 12_000

/** Pull the email out of a From header ("Marcus <m@x.com>" → "m@x.com"). */
export function parseFromEmail(raw: string): string {
  const angle = raw.match(/<([^>]+)>/)
  const candidate = (angle ? angle[1] : raw).trim().toLowerCase()
  const m = candidate.match(/[^\s<>@,;]+@[^\s<>@,;]+/)
  return m ? m[0] : ""
}

/** Strip leading Re:/Fwd:/Fw: (repeatedly) and collapse whitespace. */
export function normalizeSubject(subject: string): string {
  let s = subject.trim()
  let prev: string
  do {
    prev = s
    s = s.replace(/^(re|fwd?|fw)\s*:\s*/i, "")
  } while (s !== prev)
  return s.replace(/\s+/g, " ").trim().toLowerCase()
}

/** Parse folded RFC-5322 headers into a lowercased-key → first-value map. */
function parseHeaders(headerBlock: string): Map<string, string> {
  // Unfold: a line starting with whitespace continues the previous header.
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ")
  const headers = new Map<string, string>()
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key && !headers.has(key)) headers.set(key, value)
  }
  return headers
}

function toIso(dateHeader: string | undefined): string | null {
  if (!dateHeader) return null
  const ts = Date.parse(dateHeader)
  return Number.isNaN(ts) ? null : new Date(ts).toISOString()
}

/**
 * Split a raw mbox into messages. Messages are separated by a line beginning
 * with "From " (the mbox envelope, distinct from the "From:" header). Body lines
 * that were ">"-escaped to protect a literal "From " are unescaped.
 */
export function parseMboxMessages(content: string): MboxMessage[] {
  const normalized = content.replace(/\r\n/g, "\n")
  // Split on envelope separators at line start. The mbox envelope is "From "
  // (note the SPACE: "From sender ... <date with colons>"), which the "From:"
  // header never matches (colon, no space). So we key on the space, not on the
  // absence of a colon — the envelope's timestamp is full of colons.
  const chunks = normalized
    .split(/\n(?=From )/)
    .map((c) => c.replace(/^From .*\n/, "")) // drop the envelope line
    .filter((c) => c.trim().length > 0)

  const messages: MboxMessage[] = []
  for (const chunk of chunks) {
    const sep = chunk.indexOf("\n\n")
    const headerBlock = sep === -1 ? chunk : chunk.slice(0, sep)
    const rawBody = sep === -1 ? "" : chunk.slice(sep + 2)
    const body = rawBody.replace(/^>(>*From )/gm, "$1").trim()

    const headers = parseHeaders(headerBlock)
    const from = headers.get("from") ?? ""
    messages.push({
      messageId: headers.get("message-id") ?? null,
      from,
      fromEmail: parseFromEmail(from),
      subject: headers.get("subject") ?? "",
      date: toIso(headers.get("date")),
      hasListUnsubscribe: headers.has("list-unsubscribe"),
      body,
    })
  }
  return messages
}

function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}

/**
 * Group messages into threads by normalized subject (empty subjects never
 * group together), and mark owner participation from the shop's own addresses.
 * The thread's fromEmail is the first non-shop sender (the customer side).
 */
export function buildThreads(
  messages: MboxMessage[],
  shopAddresses: string[]
): RecoveryThread[] {
  const shop = new Set(
    shopAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean)
  )
  const isShop = (email: string) => shop.has(email)

  // Preserve first-seen order of groups.
  const order: string[] = []
  const groups = new Map<string, MboxMessage[]>()
  messages.forEach((m, i) => {
    const norm = normalizeSubject(m.subject)
    // Empty subjects are unthreadable — key each uniquely so they stay apart.
    const key = norm ? `s:${norm}` : `u:${m.messageId ?? i}`
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    groups.get(key)!.push(m)
  })

  const threads: RecoveryThread[] = []
  for (const key of order) {
    const group = groups.get(key)!
    const ownerParticipated = group.some((m) => isShop(m.fromEmail))
    const customer = group.find((m) => m.fromEmail && !isShop(m.fromEmail))
    const fromEmail = customer?.fromEmail ?? group[0].fromEmail ?? ""

    const body = group
      .map((m) =>
        [
          `From: ${m.from}`,
          m.date ? `Date: ${m.date}` : null,
          `Subject: ${m.subject}`,
          "",
          m.body,
        ]
          .filter((l) => l !== null)
          .join("\n")
      )
      .join("\n\n---\n\n")
      .slice(0, MAX_THREAD_BODY)

    threads.push({
      messageId: group[group.length - 1].messageId,
      fromEmail,
      subject: group[0].subject,
      hasListUnsubscribe: group.some((m) => m.hasListUnsubscribe),
      ownerParticipated,
      date: group.reduce<string | null>((acc, m) => laterIso(acc, m.date), null),
      body,
    })
  }
  return threads
}
