/**
 * Customer Recovery dedupe/merge (P8 / NEXT-3, GRADIA_CUSTOMER_RECOVERY_SPEC
 * §2.2). Deterministic matching in CODE — never the LLM. Normalizes phones and
 * emails, collapses duplicate candidates within the import set, then matches
 * each group against the existing CRM:
 *
 *   merge_into existing · new_customer · ambiguous (owner takes a look)
 *
 * "Ambiguous" is deliberately conservative: conflicting names on the same
 * number, or a candidate that matches more than one existing customer, gets
 * flagged for the owner rather than auto-merged (we never auto-merge two
 * customers — same rule as findOrCreateCustomer).
 *
 * Pure + deterministic → fully unit-tested without a DB.
 */

import { normalizeEmail, normalizePhone } from "@/lib/customers"

/** Last-10-digits key so "+1 415 555 0142" and "(415) 555-0142" match. */
export function phoneKey(raw: string | null | undefined): string | null {
  const norm = normalizePhone(raw)
  if (!norm) return null
  const digits = norm.replace(/\D/g, "")
  if (!digits) return null
  return digits.length > 10 ? digits.slice(-10) : digits
}

/** Lowercased, trimmed email — a strong identity signal. */
export function emailKey(raw: string | null | undefined): string | null {
  return normalizeEmail(raw)
}

/** Loose name equality: case/space/punctuation-insensitive. */
function normName(name: string | null | undefined): string | null {
  if (!name) return null
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  return n || null
}

/** One extracted candidate plus a provenance handle the caller cares about. */
export type ImportCandidate<P = unknown> = {
  name: string | null
  phones: string[]
  emails: string[]
  provenance: P
}

/** A set of candidates that resolved to the same person within the import. */
export type CandidateGroup<P = unknown> = {
  names: string[]
  phones: string[]
  emails: string[]
  members: P[]
  /** Two members carried conflicting non-empty names. */
  nameConflict: boolean
}

export type ExistingCustomer = {
  id: string
  name: string | null
  phone: string | null
  email: string | null
}

export type MatchDecision =
  | { kind: "merge_into"; customerId: string }
  | { kind: "new" }
  | { kind: "ambiguous"; reason: string; customerId?: string }

export type ResolvedCandidate<P = unknown> = {
  group: CandidateGroup<P>
  decision: MatchDecision
}

function keysOf(c: { phones: string[]; emails: string[] }): {
  phones: Set<string>
  emails: Set<string>
} {
  const phones = new Set<string>()
  const emails = new Set<string>()
  for (const p of c.phones) {
    const k = phoneKey(p)
    if (k) phones.add(k)
  }
  for (const e of c.emails) {
    const k = emailKey(e)
    if (k) emails.add(k)
  }
  return { phones, emails }
}

/**
 * Collapse candidates that share any phone or email into one group
 * (union-find over the shared-identifier graph). Two import rows for the same
 * person — a thread and a contact card — become a single group.
 */
export function mergeWithinSet<P>(
  candidates: ImportCandidate<P>[]
): CandidateGroup<P>[] {
  const parent = candidates.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b)
  }

  // Map each identifier key to the first candidate index that owns it; union
  // any later owner with that first one.
  const phoneOwner = new Map<string, number>()
  const emailOwner = new Map<string, number>()
  candidates.forEach((c, i) => {
    const { phones, emails } = keysOf(c)
    for (const k of phones) {
      const owner = phoneOwner.get(k)
      if (owner === undefined) phoneOwner.set(k, i)
      else union(i, owner)
    }
    for (const k of emails) {
      const owner = emailOwner.get(k)
      if (owner === undefined) emailOwner.set(k, i)
      else union(i, owner)
    }
  })

  const groupsByRoot = new Map<number, CandidateGroup<P>>()
  candidates.forEach((c, i) => {
    const root = find(i)
    let g = groupsByRoot.get(root)
    if (!g) {
      g = { names: [], phones: [], emails: [], members: [], nameConflict: false }
      groupsByRoot.set(root, g)
    }
    if (c.name && !g.names.includes(c.name)) g.names.push(c.name)
    for (const p of c.phones) if (!g.phones.includes(p)) g.phones.push(p)
    for (const e of c.emails) if (!g.emails.includes(e)) g.emails.push(e)
    g.members.push(c.provenance)
  })

  for (const g of groupsByRoot.values()) {
    const distinct = new Set(g.names.map(normName).filter(Boolean))
    g.nameConflict = distinct.size > 1
  }

  return [...groupsByRoot.values()]
}

/** Match one merged group against the existing CRM. */
export function classifyGroup<P>(
  group: CandidateGroup<P>,
  existing: ExistingCustomer[]
): MatchDecision {
  const gKeys = keysOf(group)

  const phoneMatches = new Set<string>()
  const emailMatches = new Set<string>()
  for (const cust of existing) {
    const pk = phoneKey(cust.phone)
    const ek = emailKey(cust.email)
    if (pk && gKeys.phones.has(pk)) phoneMatches.add(cust.id)
    if (ek && gKeys.emails.has(ek)) emailMatches.add(cust.id)
  }

  const matchedIds = new Set<string>([...phoneMatches, ...emailMatches])

  if (matchedIds.size === 0) {
    // A within-set name clash with no CRM match still needs the owner's eye.
    if (group.nameConflict) {
      return { kind: "ambiguous", reason: "conflicting names on the same number" }
    }
    return { kind: "new" }
  }

  if (matchedIds.size > 1) {
    return { kind: "ambiguous", reason: "matches more than one existing customer" }
  }

  const customerId = [...matchedIds][0]
  const matched = existing.find((c) => c.id === customerId)!
  const matchedByEmail = emailMatches.has(customerId)

  // Conflicting names on a phone-only match → flag. Email is a strong enough
  // identity signal that a different display name (nickname) still merges.
  if (!matchedByEmail) {
    const gName = group.names.map(normName).find(Boolean) ?? null
    const cName = normName(matched.name)
    if (gName && cName && gName !== cName) {
      return {
        kind: "ambiguous",
        reason: "conflicting names on the same number",
        customerId,
      }
    }
  }

  return { kind: "merge_into", customerId }
}

/** Full resolution: collapse the import set, then classify each group. */
export function resolveImportSet<P>(
  candidates: ImportCandidate<P>[],
  existing: ExistingCustomer[]
): ResolvedCandidate<P>[] {
  return mergeWithinSet(candidates).map((group) => ({
    group,
    decision: classifyGroup(group, existing),
  }))
}
