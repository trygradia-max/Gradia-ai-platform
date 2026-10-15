import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  canTeamCommand,
  teamCommandSchema,
  type TeamWorkspace,
} from "@/lib/team-permissions"
import { runTeamCommand } from "@/app/actions/team"
const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  getUser: vi.fn(),
  revalidate: vi.fn(),
}))
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: mock.rpc,
    auth: { getUser: mock.getUser },
  }),
}))
vi.mock("next/cache", () => ({ revalidatePath: mock.revalidate }))
const shop = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222"
const member = "33333333-3333-4333-8333-333333333333"
const workspace = (
  role: TeamWorkspace["role"],
  capabilities: TeamWorkspace["capabilities"] = []
): TeamWorkspace => ({
  id: shop,
  name: "Synthetic",
  role,
  capabilities,
  location_id: other,
})
const note = {
  operation: "note" as const,
  shopId: shop,
  customerId: other,
  content: "Synthetic note",
}
const invite = {
  operation: "invite" as const,
  shopId: shop,
  name: "Fictional teammate",
  email: "member@example.test",
  role: "staff" as const,
  capabilities: [],
}
beforeEach(() => {
  vi.clearAllMocks()
  mock.getUser.mockResolvedValue({
    data: { user: { id: member } },
    error: null,
  })
  mock.rpc.mockResolvedValue({ data: [workspace("owner")], error: null })
})
describe("team command contract", () => {
  it.each(["owner", "manager", "staff"] as const)(
    "rejects foreign shop for %s",
    (role) =>
      expect(canTeamCommand(workspace(role), { ...note, shopId: other })).toBe(
        false
      )
  )
  it.each(["manager", "staff"] as const)(
    "%s cannot invite or change membership",
    (role) => {
      expect(canTeamCommand(workspace(role), invite)).toBe(false)
      expect(
        canTeamCommand(workspace(role), {
          operation: "member",
          shopId: shop,
          memberId: member,
          role: "manager",
          active: true,
          capabilities: [],
        })
      ).toBe(false)
    }
  )
  it("manager starts with no operational grants", () =>
    expect(canTeamCommand(workspace("manager"), note)).toBe(false))
  it("explicit note grant permits server precheck; DB still checks record", () =>
    expect(canTeamCommand(workspace("manager", ["notes.write"]), note)).toBe(
      true
    ))
  it("staff note authority still requires assigned-record DB check", () =>
    expect(canTeamCommand(workspace("staff"), note)).toBe(true))
  it("owner solo behavior is preserved", () =>
    expect(canTeamCommand(workspace("owner"), invite)).toBe(true))
  it.each([
    "members.manage",
    "connectors.manage",
    "autonomy.write",
    "export",
    "merge",
    "send_sms",
  ])("rejects unsupported grant %s", (capability) =>
    expect(
      teamCommandSchema.safeParse({
        ...invite,
        role: "manager",
        capabilities: [capability],
      }).success
    ).toBe(false)
  )
  it("rejects owner invitation", () =>
    expect(
      teamCommandSchema.safeParse({ ...invite, role: "owner" }).success
    ).toBe(false))
  it("rejects manager grants attached to staff", () =>
    expect(
      teamCommandSchema.safeParse({ ...invite, capabilities: ["crm.read"] })
        .success
    ).toBe(false))
  it.each([
    [null, null],
    [other, member],
  ])("requires exactly one assignment parent", (customerId, appointmentId) =>
    expect(
      teamCommandSchema.safeParse({
        operation: "assign",
        shopId: shop,
        memberId: member,
        customerId,
        appointmentId,
        remove: false,
      }).success
    ).toBe(false)
  )
  it("rejects payment progress", () =>
    expect(
      teamCommandSchema.safeParse({
        operation: "progress",
        shopId: shop,
        appointmentId: member,
        expected: "completed",
        status: "paid",
      }).success
    ).toBe(false))
})
describe("direct server action authorization", () => {
  it("malformed command causes zero auth/database calls", async () => {
    expect((await runTeamCommand({ ...note, shopId: "bad" })).ok).toBe(false)
    expect(mock.getUser).not.toHaveBeenCalled()
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it("anonymous requests cannot mutate", async () => {
    mock.getUser.mockResolvedValue({ data: { user: null }, error: null })
    expect((await runTeamCommand(note)).ok).toBe(false)
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it("auth lookup error fails closed even if a user was returned", async () => {
    mock.getUser.mockResolvedValue({
      data: { user: { id: member } },
      error: { message: "failed" },
    })
    expect((await runTeamCommand(note)).ok).toBe(false)
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it.each([{ rows: [] }, { rows: [workspace("staff")] }])(
    "missing/revoked or staff membership cannot invite",
    async ({ rows }) => {
      mock.rpc.mockResolvedValue({ data: rows, error: null })
      expect((await runTeamCommand(invite)).ok).toBe(false)
      expect(mock.rpc).toHaveBeenCalledTimes(1)
    }
  )
  it("lookup errors never grant access", async () => {
    mock.rpc.mockResolvedValue({
      data: [workspace("owner")],
      error: { message: "failed" },
    })
    expect((await runTeamCommand(note)).ok).toBe(false)
    expect(mock.rpc).toHaveBeenCalledTimes(1)
  })
  it("foreign shop identifier is denied before mutation RPC", async () => {
    expect((await runTeamCommand({ ...note, shopId: other })).ok).toBe(false)
    expect(mock.rpc).toHaveBeenCalledTimes(1)
  })
  it("does not forward caller-controlled actor identity", async () => {
    mock.rpc
      .mockResolvedValueOnce({ data: [workspace("owner")], error: null })
      .mockResolvedValueOnce({ data: member, error: null })
    expect((await runTeamCommand({ ...note, actor_id: other })).ok).toBe(true)
    expect(mock.rpc).toHaveBeenLastCalledWith("team_add_note", {
      p_shop: shop,
      p_customer: other,
      p_content: "Synthetic note",
    })
  })
  it("mutation refusal is surfaced without leaking DB details", async () => {
    mock.rpc
      .mockResolvedValueOnce({ data: [workspace("owner")], error: null })
      .mockResolvedValueOnce({ error: { message: "private diagnostic" } })
    const result = await runTeamCommand(note)
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain("private diagnostic")
    expect(mock.revalidate).not.toHaveBeenCalled()
  })
  it("invitation acceptance requires session but no pre-existing membership", async () => {
    mock.rpc.mockResolvedValue({ data: shop, error: null })
    expect(
      (await runTeamCommand({ operation: "accept", token: "a".repeat(64) })).ok
    ).toBe(true)
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("team_accept_invite", {
      p_token: "a".repeat(64),
    })
  })
})
