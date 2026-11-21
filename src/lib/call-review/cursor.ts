import { z } from "zod"

/**
 * Keyset cursor for the call list: `<ISO time>|<call id>`. A selector, never authority: the database re-checks the
 * viewer and the shop on every read. Anything that does not parse is treated as "no cursor" by the caller, so a
 * hand-edited URL shows the newest calls rather than an error or someone else's data.
 */
const uuid = z.string().uuid()
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

export type CallCursor = { createdAt: string; id: string }

export function parseCallCursor(raw: string | string[] | undefined): CallCursor | null {
  if (typeof raw !== "string" || raw.length > 80) return null
  const [createdAt, id, extra] = raw.split("|")
  if (extra !== undefined || !createdAt || !id) return null
  if (!ISO.test(createdAt) || Number.isNaN(Date.parse(createdAt)) || !uuid.safeParse(id).success) return null
  return { createdAt, id }
}

export const formatCallCursor = (c: CallCursor): string => `${c.createdAt}|${c.id}`
