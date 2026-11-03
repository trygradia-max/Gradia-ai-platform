export type MembershipForCounting = {
  user_id: string | null
  role: string
  active: boolean
}

const KNOWN_ROLES = new Set(["owner", "manager", "staff"])

/**
 * Counts distinct active workspace members. This is operational evidence,
 * not a billing decision: invitations, inactive/revoked rows and unknown
 * roles are excluded, while the founder still decides which roles are paid.
 */
export function activeMembershipCount(rows: readonly MembershipForCounting[]): number {
  const users = new Set<string>()
  for (const row of rows) {
    if (!row.active || !row.user_id || !KNOWN_ROLES.has(row.role)) continue
    users.add(row.user_id)
  }
  return users.size
}
