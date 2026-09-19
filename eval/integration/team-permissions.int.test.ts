import { beforeAll, afterAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  INTEGRATION_WITH_SESSION,
  serviceClient,
  ownerSessionClient,
  seedShop,
  anonClient,
  type Seeded,
} from "./_db"

describe.skipIf(!INTEGRATION_WITH_SESSION)(
  "membership authority against PostgreSQL",
  () => {
    let db: SupabaseClient,
      owner: SupabaseClient,
      manager: SupabaseClient,
      staff: SupabaseClient,
      stranger: SupabaseClient
    let shop: Seeded,
      foreign: Seeded,
      customer: string,
      otherCustomer: string,
      job: string,
      foreignCustomer: string
    let managerId: string,
      staffId: string,
      staffUser: string,
      managerUser: string
    const userIds: string[] = []
    const password = "Disposable-Team-Fixture-Only-927!"
    async function rpc(
      client: SupabaseClient,
      name: string,
      args: Record<string, unknown>
    ) {
      const r = await client.rpc(name, args)
      if (r.error)
        throw new Error(`${name}: ${r.error.code} ${r.error.message}`)
      return r.data
    }
    async function user() {
      const email = `team-${crypto.randomUUID()}@example.test`
      const r = await db.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })
      if (r.error || !r.data.user) throw new Error("Synthetic user failed")
      userIds.push(r.data.user.id)
      return {
        client: await ownerSessionClient(email, password),
        email,
        id: r.data.user.id,
      }
    }
    async function invite(
      client: SupabaseClient,
      email: string,
      role = "staff",
      capabilities: string[] = []
    ) {
      return rpc(client, "team_invite", {
        p_shop: shop.shopId,
        p_email: email,
        p_name: "Fictional teammate",
        p_role: role,
        p_capabilities: capabilities,
      }) as Promise<{ id: string; token: string }>
    }
    async function setManager(capabilities: string[]) {
      await rpc(owner, "team_set_member", {
        p_shop: shop.shopId,
        p_member: managerId,
        p_role: "manager",
        p_active: true,
        p_capabilities: capabilities,
      })
    }
    beforeAll(async () => {
      db = serviceClient()
      shop = await seedShop(db, { password })
      foreign = await seedShop(db, { password })
      owner = await ownerSessionClient(shop.email, password)
      const m = await user(),
        s = await user(),
        x = await user()
      manager = m.client
      staff = s.client
      stranger = x.client
      staffUser = s.id
      managerUser = m.id
      for (const [u, role] of [
        [m, "manager"],
        [s, "staff"],
      ] as const) {
        const inv = await invite(owner, u.email, role)
        await rpc(u.client, "team_accept_invite", { p_token: inv.token })
      }
      const ms = await db
        .from("shop_memberships")
        .select("id,user_id")
        .eq("shop_id", shop.shopId)
      managerId = ms.data!.find((m) => m.user_id === managerUser)!.id
      staffId = ms.data!.find((m) => m.user_id === staffUser)!.id
      for (const [i, target] of [
        [0, shop.shopId],
        [1, shop.shopId],
        [2, foreign.shopId],
      ] as const) {
        const r = await db
          .from("customers")
          .insert({ shop_id: target, name: `Synthetic ${i}` })
          .select("id")
          .single()
        if (r.error) throw r.error
        if (i === 0) customer = r.data.id
        else if (i === 1) otherCustomer = r.data.id
        else foreignCustomer = r.data.id
      }
      const r = await db
        .from("appointments")
        .insert({
          shop_id: shop.shopId,
          customer_id: customer,
          scheduled_at: "2027-01-01T12:00:00Z",
          status: "booked",
        })
        .select("id")
        .single()
      if (r.error) throw r.error
      job = r.data.id
    })
    afterAll(async () => {
      if (!db) return
      if (shop) {
        await db.from("shop_assignments").delete().eq("shop_id", shop.shopId)
        await db.from("shops").delete().eq("id", shop.shopId)
        await db.auth.admin.deleteUser(shop.ownerId)
      }
      if (foreign) {
        await db.from("shops").delete().eq("id", foreign.shopId)
        await db.auth.admin.deleteUser(foreign.ownerId)
      }
      for (const id of userIds) await db.auth.admin.deleteUser(id)
    })
    it("new solo shop has one owner and one location, no owner behavior loss", async () => {
      const work = await rpc(owner, "team_workspaces", {})
      expect(work).toHaveLength(1)
      expect(work[0].role).toBe("owner")
      const r = await owner
        .from("shops")
        .update({ name: "Synthetic renamed" })
        .eq("id", shop.shopId)
        .select("id")
      expect(r.error).toBeNull()
      expect(r.data).toHaveLength(1)
      const locations = await db
        .from("shop_locations")
        .select("id")
        .eq("shop_id", shop.shopId)
      expect(locations.data).toHaveLength(1)
      expect(
        (await db.from("shop_locations").insert({ shop_id: shop.shopId })).error
      ).not.toBeNull()
    })
    it.each(["manager", "staff"])(
      "%s cannot read credential-bearing shops",
      async (role) => {
        const r = await (role === "manager" ? manager : staff)
          .from("shops")
          .select("*")
          .eq("id", shop.shopId)
        expect(r.error).toBeNull()
        expect(r.data).toEqual([])
      }
    )
    it("default manager has no unassigned CRM access", async () => {
      expect(
        (
          await manager
            .from("customers")
            .select("id")
            .eq("shop_id", shop.shopId)
        ).data
      ).toEqual([])
    })
    it("staff has no records until assigned", async () => {
      expect(
        (await staff.from("customers").select("id").eq("shop_id", shop.shopId))
          .data
      ).toEqual([])
    })
    it.each(["manager", "staff"])(
      "%s cannot escalate, invite or revoke",
      async (role) => {
        const c = role === "manager" ? manager : staff
        expect(
          (
            await c.rpc("team_set_member", {
              p_shop: shop.shopId,
              p_member: staffId,
              p_role: "manager",
              p_active: true,
              p_capabilities: ["crm.read"],
            })
          ).error
        ).not.toBeNull()
        expect(
          (
            await c.rpc("team_invite", {
              p_shop: shop.shopId,
              p_email: "forged@example.test",
              p_name: "Forged",
              p_role: "manager",
              p_capabilities: [],
            })
          ).error
        ).not.toBeNull()
        expect(
          (
            await c
              .from("shop_memberships")
              .update({ role: "owner" })
              .eq("id", staffId)
          ).error
        ).not.toBeNull()
      }
    )
    it("owner cannot remove own membership or grant unsupported authority", async () => {
      const row = await db
        .from("shop_memberships")
        .select("id")
        .eq("shop_id", shop.shopId)
        .eq("role", "owner")
        .single()
      expect(
        (
          await owner.rpc("team_set_member", {
            p_shop: shop.shopId,
            p_member: row.data!.id,
            p_role: "staff",
            p_active: false,
            p_capabilities: [],
          })
        ).error
      ).not.toBeNull()
      expect(
        (
          await owner.rpc("team_set_member", {
            p_shop: shop.shopId,
            p_member: managerId,
            p_role: "manager",
            p_active: true,
            p_capabilities: ["autonomy.write"],
          })
        ).error
      ).not.toBeNull()
    })
    it("owner assigns a job; staff sees exactly that job and its customer", async () => {
      await rpc(owner, "team_assign", {
        p_shop: shop.shopId,
        p_member: staffId,
        p_appointment: job,
      })
      expect(
        (await staff.from("customers").select("id").eq("shop_id", shop.shopId))
          .data
      ).toEqual([{ id: customer }])
      expect(
        (
          await staff
            .from("appointments")
            .select("id")
            .eq("shop_id", shop.shopId)
        ).data
      ).toEqual([{ id: job }])
    })
    it("staff note writes use real actor and cannot target another customer", async () => {
      const id = await rpc(staff, "team_add_note", {
        p_shop: shop.shopId,
        p_customer: customer,
        p_content: "Fictional staff note",
      })
      const row = await db
        .from("interactions")
        .select("metadata,channel")
        .eq("id", id)
        .single()
      expect(row.data?.metadata.actor_id).toBe(staffUser)
      expect(row.data?.channel).toBe("note")
      expect(
        (
          await staff.rpc("team_add_note", {
            p_shop: shop.shopId,
            p_customer: otherCustomer,
            p_content: "Denied",
          })
        ).error
      ).not.toBeNull()
      const audit = await db
        .from("shop_team_audit")
        .select("actor_id,event")
        .eq("subject_id", id)
      expect(audit.data).toEqual([{ actor_id: staffUser, event: "note_added" }])
    })
    it("staff progress rejects stale states and payments", async () => {
      await rpc(staff, "team_job_progress", {
        p_shop: shop.shopId,
        p_appointment: job,
        p_expected: "booked",
        p_status: "checked_in",
      })
      expect(
        (
          await staff.rpc("team_job_progress", {
            p_shop: shop.shopId,
            p_appointment: job,
            p_expected: "booked",
            p_status: "checked_in",
          })
        ).error
      ).not.toBeNull()
      expect(
        (
          await staff.rpc("team_job_progress", {
            p_shop: shop.shopId,
            p_appointment: job,
            p_expected: "checked_in",
            p_status: "paid",
          })
        ).error
      ).not.toBeNull()
    })
    it("staff cannot forge unrestricted direct writes, pending approvals or consent", async () => {
      const r = await staff
        .from("customers")
        .update({ name: "Forged" })
        .eq("id", customer)
        .select("id")
      expect(r.data ?? []).toEqual([])
      const j = await staff
        .from("appointments")
        .update({ status: "paid" })
        .eq("id", job)
        .select("id")
      expect(j.data ?? []).toEqual([])
      expect(
        (
          await staff.from("interactions").insert({
            shop_id: shop.shopId,
            customer_id: customer,
            channel: "sms",
            role: "gradia",
            content: "Denied",
          })
        ).error
      ).not.toBeNull()
      expect(
        (
          await staff.from("pending_actions").insert({
            shop_id: shop.shopId,
            action_type: "send_sms",
            payload: {},
            requested_by: "forged",
          })
        ).error
      ).not.toBeNull()
    })
    it("explicit manager grants allow operations but no sensitive owner powers", async () => {
      await setManager([
        "crm.read",
        "notes.write",
        "jobs.progress",
        "assignments.manage",
      ])
      expect(
        (
          await manager
            .from("customers")
            .select("id")
            .eq("shop_id", shop.shopId)
        ).data
      ).toHaveLength(2)
      await rpc(manager, "team_assign", {
        p_shop: shop.shopId,
        p_member: staffId,
        p_customer: otherCustomer,
      })
      expect(
        (
          await manager.rpc("team_assign", {
            p_shop: shop.shopId,
            p_member: managerId,
            p_customer: customer,
          })
        ).error
      ).not.toBeNull()
      await rpc(manager, "team_add_note", {
        p_shop: shop.shopId,
        p_customer: otherCustomer,
        p_content: "Delegated synthetic note",
      })
      expect(
        (
          await manager
            .from("shops")
            .update({ name: "Forbidden" })
            .eq("id", shop.shopId)
            .select("id")
        ).data
      ).toEqual([])
      expect(
        (
          await manager.rpc("merge_customers_atomic", {
            p_shop: shop.shopId,
            p_winner: customer,
            p_loser: otherCustomer,
          })
        ).error
      ).not.toBeNull()
    })
    it("cross-shop identifiers fail at RPC and composite foreign keys", async () => {
      expect(
        (
          await manager
            .from("customers")
            .select("id")
            .eq("shop_id", foreign.shopId)
        ).data
      ).toEqual([])
      expect(
        (
          await owner.rpc("team_assign", {
            p_shop: shop.shopId,
            p_member: staffId,
            p_customer: foreignCustomer,
          })
        ).error
      ).not.toBeNull()
      expect(
        (
          await owner.rpc("team_add_note", {
            p_shop: shop.shopId,
            p_customer: foreignCustomer,
            p_content: "Denied",
          })
        ).error
      ).not.toBeNull()
      expect(
        (
          await db.from("shop_assignments").insert({
            shop_id: shop.shopId,
            member_id: staffId,
            customer_id: foreignCustomer,
          })
        ).error?.code
      ).toBe("23503")
      expect(
        (
          await stranger.rpc("team_add_note", {
            p_shop: shop.shopId,
            p_customer: customer,
            p_content: "Denied",
          })
        ).error
      ).not.toBeNull()
    })
    it("audit is owner-readable and immutable to authenticated actors", async () => {
      expect(
        (
          await owner
            .from("shop_team_audit")
            .select("id")
            .eq("shop_id", shop.shopId)
        ).data!.length
      ).toBeGreaterThan(0)
      expect(
        (
          await manager
            .from("shop_team_audit")
            .select("id")
            .eq("shop_id", shop.shopId)
        ).data
      ).toEqual([])
      expect(
        (
          await owner.from("shop_team_audit").insert({
            shop_id: shop.shopId,
            actor_id: staffUser,
            event: "forged",
            subject_id: customer,
          })
        ).error
      ).not.toBeNull()
      expect(
        (
          await owner
            .from("shop_team_audit")
            .delete()
            .eq("shop_id", shop.shopId)
        ).error
      ).not.toBeNull()
    })
    it("revocation takes effect with same JWT and clears assignments", async () => {
      await rpc(owner, "team_set_member", {
        p_shop: shop.shopId,
        p_member: staffId,
        p_role: "staff",
        p_active: false,
        p_capabilities: [],
      })
      expect(
        (await staff.from("customers").select("id").eq("shop_id", shop.shopId))
          .data
      ).toEqual([])
      expect(await rpc(staff, "team_workspaces", {})).toEqual([])
      expect(
        (
          await staff.rpc("team_add_note", {
            p_shop: shop.shopId,
            p_customer: customer,
            p_content: "Denied after revoke",
          })
        ).error
      ).not.toBeNull()
      await rpc(owner, "team_set_member", {
        p_shop: shop.shopId,
        p_member: staffId,
        p_role: "staff",
        p_active: true,
        p_capabilities: [],
      })
      expect(
        (await staff.from("customers").select("id").eq("shop_id", shop.shopId))
          .data
      ).toEqual([])
    })
    it("manager grant reduction is effective without new login", async () => {
      await setManager([])
      expect(
        (
          await manager.rpc("team_add_note", {
            p_shop: shop.shopId,
            p_customer: customer,
            p_content: "No longer permitted",
          })
        ).error
      ).not.toBeNull()
      expect(
        (
          await manager
            .from("customers")
            .select("id")
            .eq("shop_id", shop.shopId)
        ).data
      ).toEqual([])
    })
    it("invitation is verified-email bound and has one concurrent acceptance winner", async () => {
      const u = await user(),
        inv = await invite(owner, u.email)
      expect(
        (await stranger.rpc("team_accept_invite", { p_token: inv.token })).error
      ).not.toBeNull()
      const results = await Promise.all([
        u.client.rpc("team_accept_invite", { p_token: inv.token }),
        u.client.rpc("team_accept_invite", { p_token: inv.token }),
      ])
      expect(results.filter((r) => !r.error)).toHaveLength(1)
      expect(results.filter((r) => r.error)).toHaveLength(1)
      expect(
        (await u.client.rpc("team_accept_invite", { p_token: inv.token })).error
      ).not.toBeNull()
      const stored = await db
        .from("shop_invitations")
        .select("token_hash,status,accepted_by")
        .eq("id", inv.id)
        .single()
      expect(stored.data?.token_hash).not.toBe(inv.token)
      expect(stored.data?.accepted_by).toBe(u.id)
    })
    it("cancelled, expired, forged and reissued invitation codes fail", async () => {
      const u = await user(),
        first = await invite(owner, u.email),
        second = await invite(owner, u.email)
      expect(
        (await u.client.rpc("team_accept_invite", { p_token: first.token }))
          .error
      ).not.toBeNull()
      await rpc(owner, "team_cancel_invite", {
        p_shop: shop.shopId,
        p_invitation: second.id,
      })
      expect(
        (await u.client.rpc("team_accept_invite", { p_token: second.token }))
          .error
      ).not.toBeNull()
      const expired = await invite(owner, u.email)
      await db
        .from("shop_invitations")
        .update({ expires_at: "2000-01-01T00:00:00Z" })
        .eq("id", expired.id)
      expect(
        (await u.client.rpc("team_accept_invite", { p_token: expired.token }))
          .error
      ).not.toBeNull()
      expect(
        (await u.client.rpc("team_accept_invite", { p_token: "0".repeat(64) }))
          .error
      ).not.toBeNull()
    })
    it("revocation cancels outstanding re-invitations instead of allowing stale re-entry", async () => {
      const u = await user(),
        first = await invite(owner, u.email)
      await rpc(u.client, "team_accept_invite", { p_token: first.token })
      const membership = await db
        .from("shop_memberships")
        .select("id")
        .eq("shop_id", shop.shopId)
        .eq("user_id", u.id)
        .single()
      const pending = await invite(owner, u.email)
      await rpc(owner, "team_set_member", {
        p_shop: shop.shopId,
        p_member: membership.data!.id,
        p_role: "staff",
        p_active: false,
        p_capabilities: [],
      })
      expect(
        (await u.client.rpc("team_accept_invite", { p_token: pending.token }))
          .error
      ).not.toBeNull()
      expect(await rpc(u.client, "team_workspaces", {})).toEqual([])
    })
    it("invalid reissue rolls back and keeps the prior invitation valid", async () => {
      const u = await user(),
        first = await invite(owner, u.email)
      expect(
        (
          await owner.rpc("team_invite", {
            p_shop: shop.shopId,
            p_email: u.email,
            p_name: "Fictional",
            p_role: "owner",
            p_capabilities: [],
          })
        ).error
      ).not.toBeNull()
      expect(
        await rpc(u.client, "team_accept_invite", { p_token: first.token })
      ).toBe(shop.shopId)
    })
    it("database refuses inconsistent owner roles even from privileged fixture client", async () => {
      expect(
        (
          await db
            .from("shop_memberships")
            .update({ role: "owner" })
            .eq("id", staffId)
        ).error?.code
      ).toBe("23514")
      expect(
        (
          await db
            .from("shop_memberships")
            .update({ active: false })
            .eq("shop_id", shop.shopId)
            .eq("role", "owner")
        ).error?.code
      ).toBe("23514")
    })
    it("assigned-customer merge fails atomically rather than silently dropping or widening assignments", async () => {
      await rpc(owner, "team_assign", {
        p_shop: shop.shopId,
        p_member: staffId,
        p_customer: otherCustomer,
      })
      const before = await db
        .from("customers")
        .select("id,name")
        .eq("shop_id", shop.shopId)
        .order("id")
      expect(
        (
          await owner.rpc("merge_customers_atomic", {
            p_shop: shop.shopId,
            p_winner: customer,
            p_loser: otherCustomer,
          })
        ).error
      ).not.toBeNull()
      expect(
        (
          await db
            .from("customers")
            .select("id,name")
            .eq("shop_id", shop.shopId)
            .order("id")
        ).data
      ).toEqual(before.data)
      expect(
        (
          await db
            .from("shop_assignments")
            .select("id")
            .eq("shop_id", shop.shopId)
            .eq("customer_id", otherCustomer)
        ).data
      ).toHaveLength(1)
      await rpc(owner, "team_assign", {
        p_shop: shop.shopId,
        p_member: staffId,
        p_customer: otherCustomer,
        p_remove: true,
      })
    })
    it("explicit appointment deletion retains existing behavior and removes its assignment", async () => {
      const j = await db
        .from("appointments")
        .insert({ shop_id: shop.shopId, scheduled_at: "2027-02-01T00:00:00Z" })
        .select("id")
        .single()
      expect(j.error).toBeNull()
      await rpc(owner, "team_assign", {
        p_shop: shop.shopId,
        p_member: staffId,
        p_appointment: j.data!.id,
      })
      expect(
        (await owner.from("appointments").delete().eq("id", j.data!.id)).error
      ).toBeNull()
      expect(
        (
          await db
            .from("shop_assignments")
            .select("id")
            .eq("appointment_id", j.data!.id)
        ).data
      ).toEqual([])
    })
    it("denied operations leave no operational mutation or forged audit", async () => {
      const before = await db
        .from("shop_team_audit")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shop.shopId)
      const notes = await db
        .from("interactions")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shop.shopId)
      expect(
        (
          await stranger.rpc("team_add_note", {
            p_shop: shop.shopId,
            p_customer: customer,
            p_content: "Denied",
          })
        ).error
      ).not.toBeNull()
      expect(
        (
          await stranger.rpc("team_assign", {
            p_shop: shop.shopId,
            p_member: staffId,
            p_customer: customer,
          })
        ).error
      ).not.toBeNull()
      expect(
        (
          await db
            .from("shop_team_audit")
            .select("id", { count: "exact", head: true })
            .eq("shop_id", shop.shopId)
        ).count
      ).toBe(before.count)
      expect(
        (
          await db
            .from("interactions")
            .select("id", { count: "exact", head: true })
            .eq("shop_id", shop.shopId)
        ).count
      ).toBe(notes.count)
    })
    it("revocation epoch rejects old invitations across verified email changes", async () => {
      const u = await user(),
        first = await invite(owner, u.email)
      await rpc(u.client, "team_accept_invite", { p_token: first.token })
      const membership = await db
        .from("shop_memberships")
        .select("id")
        .eq("shop_id", shop.shopId)
        .eq("user_id", u.id)
        .single()
      const pending = await invite(owner, u.email)
      const changed = `changed-${crypto.randomUUID()}@example.test`
      expect(
        (
          await db.auth.admin.updateUserById(u.id, {
            email: changed,
            email_confirm: true,
          })
        ).error
      ).toBeNull()
      await rpc(owner, "team_set_member", {
        p_shop: shop.shopId,
        p_member: membership.data!.id,
        p_role: "staff",
        p_active: false,
        p_capabilities: [],
      })
      expect(
        (
          await db.auth.admin.updateUserById(u.id, {
            email: u.email,
            email_confirm: true,
          })
        ).error
      ).toBeNull()
      expect(
        (await u.client.rpc("team_accept_invite", { p_token: pending.token }))
          .error
      ).not.toBeNull()
      const fresh = await invite(owner, u.email)
      expect(
        await rpc(u.client, "team_accept_invite", { p_token: fresh.token })
      ).toBe(shop.shopId)
    })
    it("anonymous users cannot read or invoke team operations", async () => {
      const anon = anonClient()
      expect((await anon.rpc("team_workspaces")).error).not.toBeNull()
      expect(
        (await anon.from("shop_memberships").select("*")).error
      ).not.toBeNull()
    })
  }
)
