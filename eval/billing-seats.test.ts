import { describe, expect, it } from "vitest"

import { activeMembershipCount } from "@/lib/billing-seats"

describe("activeMembershipCount", () => {
  it("counts distinct active owner, manager and staff memberships", () => {
    expect(
      activeMembershipCount([
        { user_id: "owner", role: "owner", active: true },
        { user_id: "manager", role: "manager", active: true },
        { user_id: "staff", role: "staff", active: true },
        { user_id: "staff", role: "staff", active: true },
      ])
    ).toBe(3)
  })

  it("excludes inactive, pending/unbound and unknown-role rows", () => {
    expect(
      activeMembershipCount([
        { user_id: "revoked", role: "manager", active: false },
        { user_id: null, role: "staff", active: true },
        { user_id: "unknown", role: "billing_admin", active: true },
      ])
    ).toBe(0)
  })
})
