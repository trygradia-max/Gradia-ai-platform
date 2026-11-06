import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  correctMembershipBilling,
  readCommercialPeriodPreview,
  readCommercialUsagePreview,
} from "@/lib/commercial-usage-service"
import {
  INTEGRATION_WITH_SESSION,
  anonClient,
  cleanup,
  ownerSessionClient,
  seedShop,
  serviceClient,
  type Seeded,
} from "./_db"

const PW = "Synthetic-password-123!"
const DAY = 86_400_000

type EventRow = {
  id: string
  shop_seq: number
  user_id: string
  member_id: string | null
  kind: string
  previous_role: string | null
  previous_active: boolean | null
  previous_billable: boolean | null
  new_role: string | null
  new_active: boolean | null
  new_billable: boolean
  effective_at: string
  source_operation: string
  actor_id: string | null
  actor_kind: string
  db_transaction_id: number | null
  corrects_event_id: string | null
  reason: string | null
}

let db: SupabaseClient
const seeded: Seeded[] = []
let shop: Seeded, other: Seeded, manager: Seeded, staff: Seeded, revoked: Seeded
let owner: SupabaseClient, otherOwner: SupabaseClient, mgr: SupabaseClient, stf: SupabaseClient, rev: SupabaseClient

const midnight = (offsetDays: number) => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays)).toISOString()
}
const FUTURE_AS_OF = () => new Date(Date.now() + 5 * DAY).toISOString()

async function newShop(withSession = false): Promise<Seeded> {
  const s = await seedShop(db, withSession ? { password: PW } : undefined)
  seeded.push(s)
  return s
}
async function events(shopId: string): Promise<EventRow[]> {
  const r = await db.from("commercial_membership_events").select("*").eq("shop_id", shopId).order("shop_seq")
  expect(r.error).toBeNull()
  return r.data as EventRow[]
}
async function coverage(shopId: string) {
  const r = await db.from("commercial_membership_coverage").select("*").eq("shop_id", shopId).maybeSingle()
  expect(r.error).toBeNull()
  return r.data as { covered_from: string; basis: string } | null
}
async function addMember(shopId: string, user: Seeded, role: string, active = true) {
  const r = await db
    .from("shop_memberships")
    .upsert({ shop_id: shopId, user_id: user.ownerId, role, capabilities: [], active, display_name: role }, { onConflict: "shop_id,user_id" })
    .select("id")
    .single()
  expect(r.error).toBeNull()
  return r.data!.id as string
}
const setMember = (id: string, patch: Record<string, unknown>) => db.from("shop_memberships").update(patch).eq("id", id)

/** Every interval must be possible: gapless sequence, forward time, per-user continuity. */
function assertConsistent(rows: EventRow[]) {
  expect(rows.map((r) => r.shop_seq)).toEqual(rows.map((_, i) => i + 1))
  const last = new Map<string, boolean>()
  let lastTime = -Infinity
  for (const row of rows) {
    if (row.kind === "correction") continue
    expect(Date.parse(row.effective_at)).toBeGreaterThanOrEqual(lastTime)
    lastTime = Date.parse(row.effective_at)
    expect(row.previous_billable, `seq ${row.shop_seq}`).toBe(row.kind === "snapshot" ? null : (last.get(row.user_id) ?? false))
    last.set(row.user_id, row.new_billable)
  }
}

describe.skipIf(!INTEGRATION_WITH_SESSION)("membership billing history", () => {
  beforeAll(async () => {
    db = serviceClient()
    ;[shop, other, manager, staff, revoked] = await Promise.all([1, 2, 3, 4, 5].map(() => newShop(true)))
    ;[owner, otherOwner, mgr, stf, rev] = await Promise.all(
      [shop, other, manager, staff, revoked].map((s) => ownerSessionClient(s.email, PW))
    )
    await addMember(shop.shopId, manager, "manager")
    await addMember(shop.shopId, staff, "staff")
    await addMember(shop.shopId, revoked, "manager", false)
  })
  afterAll(async () => {
    for (const s of seeded) await cleanup(db, s)
  })

  describe("capture", () => {
    it("covers a new shop from its creation and records the owner as billable", async () => {
      const rows = await events(shop.shopId)
      expect(rows[0]).toMatchObject({
        shop_seq: 1,
        user_id: shop.ownerId,
        kind: "change",
        source_operation: "membership_insert",
        previous_billable: false,
        new_role: "owner",
        new_active: true,
        new_billable: true,
        actor_kind: "service_role",
      })
      expect(rows[0].db_transaction_id).not.toBeNull()
      const cov = await coverage(shop.shopId)
      expect(cov?.basis).toBe("shop_created")
      expect(Date.parse(cov!.covered_from)).toBe(Date.parse(rows[0].effective_at))
    })

    it("captures every direct trusted mutation with exact old and new state, and ignores non-billing edits", async () => {
      const t = await newShop()
      const member = await newShop()
      const id = await addMember(t.shopId, member, "manager")
      expect((await setMember(id, { role: "staff" })).error).toBeNull()
      expect((await setMember(id, { active: false })).error).toBeNull()
      expect((await setMember(id, { active: true })).error).toBeNull()
      expect((await setMember(id, { display_name: "Renamed", capabilities: [] })).error).toBeNull() // no billing effect
      expect((await setMember(id, { active: true })).error).toBeNull() // no-op
      expect((await db.from("shop_memberships").delete().eq("id", id)).error).toBeNull()

      const rows = (await events(t.shopId)).filter((r) => r.user_id === member.ownerId)
      expect(rows.map((r) => [r.source_operation, r.previous_role, r.previous_active, r.new_role, r.new_active, r.previous_billable, r.new_billable])).toEqual([
        ["membership_insert", null, null, "manager", true, false, true],
        ["membership_update", "manager", true, "staff", true, true, true],
        ["membership_update", "staff", true, "staff", false, true, false],
        ["membership_update", "staff", false, "staff", true, false, true],
        ["membership_delete", "staff", true, null, null, true, false],
      ])
      assertConsistent(await events(t.shopId))
    })

    it("captures the owner and manager RPC paths, invitation acceptance and reactivation", async () => {
      const t = await newShop(true)
      const invitee = await newShop(true)
      const ownerSession = await ownerSessionClient(t.email, PW)
      const inviteeSession = await ownerSessionClient(invitee.email, PW)
      const invite = async () => {
        const r = await ownerSession.rpc("team_invite", {
          p_shop: t.shopId, p_email: invitee.email, p_role: "staff", p_capabilities: [], p_name: "Invitee",
        })
        expect(r.error).toBeNull()
        const accepted = await inviteeSession.rpc("team_accept_invite", { p_token: (r.data as { token: string }).token })
        expect(accepted.error).toBeNull()
      }
      await invite()
      const member = (await db.from("shop_memberships").select("id").eq("shop_id", t.shopId).eq("user_id", invitee.ownerId).single()).data!.id as string
      expect((await ownerSession.rpc("team_set_member", { p_shop: t.shopId, p_member: member, p_role: "manager", p_active: true, p_capabilities: [] })).error).toBeNull()
      expect((await ownerSession.rpc("team_set_member", { p_shop: t.shopId, p_member: member, p_role: "manager", p_active: false, p_capabilities: [] })).error).toBeNull()
      await invite() // reactivation through ON CONFLICT DO UPDATE

      const rows = (await events(t.shopId)).filter((r) => r.user_id === invitee.ownerId)
      expect(rows.map((r) => [r.source_operation, r.new_role, r.new_active, r.previous_billable, r.new_billable, r.actor_id, r.actor_kind])).toEqual([
        ["membership_insert", "staff", true, false, true, invitee.ownerId, "user"],
        ["membership_update", "manager", true, true, true, t.ownerId, "user"],
        ["membership_update", "manager", false, true, false, t.ownerId, "user"],
        ["membership_update", "staff", true, false, true, invitee.ownerId, "user"],
      ])
      assertConsistent(await events(t.shopId))
    })

    it("records no evidence for a refused mutation, and leaves the membership untouched", async () => {
      const t = await newShop()
      const before = (await events(t.shopId)).length
      const refused = await db.from("shop_memberships").update({ active: false }).eq("shop_id", t.shopId).eq("user_id", t.ownerId)
      expect(refused.error?.code).toBe("23514") // owner membership must stay active
      const badRole = await db.from("shop_memberships").insert({ shop_id: t.shopId, user_id: (await newShop()).ownerId, role: "viewer" })
      expect(badRole.error).not.toBeNull()
      expect((await events(t.shopId)).length).toBe(before)
      const m = (await db.from("shop_memberships").select("active").eq("shop_id", t.shopId).eq("user_id", t.ownerId).single()).data
      expect(m?.active).toBe(true)
    })

    it("serializes concurrent changes into one possible history", async () => {
      const t = await newShop()
      const users = await Promise.all([1, 2, 3, 4, 5, 6].map(() => newShop()))
      const ids: string[] = []
      for (const u of users) ids.push(await addMember(t.shopId, u, "staff"))
      for (let round = 0; round < 3; round += 1) {
        await Promise.all(ids.map((id) => setMember(id, { active: round % 2 === 1 })))
      }
      // Several writers racing on the SAME membership.
      await Promise.all(Array.from({ length: 10 }, (_, i) => setMember(ids[0], { active: i % 2 === 0, role: i % 3 === 0 ? "manager" : "staff" })))
      const rows = await events(t.shopId)
      assertConsistent(rows)
      for (const [i, u] of users.entries()) {
        const current = (await db.from("shop_memberships").select("role, active").eq("id", ids[i]).single()).data!
        const last = rows.filter((r) => r.user_id === u.ownerId).at(-1)!
        expect({ role: last.new_role, active: last.new_active }).toEqual(current)
      }
    })
  })

  describe("authority", () => {
    const params = (shopId: string) => ({
      p_shop: shopId, p_window_start: midnight(1), p_window_end: midnight(3), p_as_of: FUTURE_AS_OF(),
    })

    it("lets only the live owner and the service role read; refuses everyone else", async () => {
      for (const client of [owner, db]) {
        const r = await client.rpc("commercial_membership_read", params(shop.shopId))
        expect(r.error).toBeNull()
        expect(r.data.coverage).not.toBeNull()
      }
      for (const [name, client] of [["manager", mgr], ["staff", stf], ["revoked", rev], ["anon", anonClient()], ["cross-shop", otherOwner]] as const) {
        const r = await client.rpc("commercial_membership_read", params(shop.shopId))
        expect(r.error?.code, name).toBe("42501")
        expect(r.data, name).toBeNull()
        expect(await readCommercialPeriodPreview(client, { shopId: shop.shopId, windowStart: midnight(1), windowEnd: midnight(3) }), name).toEqual({ status: "forbidden" })
      }
      const bad = await owner.rpc("commercial_membership_read", { ...params(shop.shopId), p_window_end: midnight(1), p_window_start: midnight(3) })
      expect(bad.error?.code).toBe("22023")
    })

    it("denies browser roles any direct table access, and gives even the service role no direct write", async () => {
      const anyEvent = (await events(shop.shopId))[0]
      for (const [name, client] of [["owner", owner], ["manager", mgr], ["staff", stf], ["anon", anonClient()]] as const) {
        for (const table of ["commercial_membership_events", "commercial_membership_coverage"]) {
          const read = await client.from(table).select("*").limit(1)
          expect(read.error, `${name} read ${table}`).not.toBeNull()
          expect(read.data ?? [], name).toEqual([])
          expect((await client.from(table).insert({ shop_id: shop.shopId }).select()).error, `${name} insert ${table}`).not.toBeNull()
          expect((await client.from(table).update({ new_billable: false }).eq("shop_id", shop.shopId).select()).error, `${name} update ${table}`).not.toBeNull()
          expect((await client.from(table).delete().eq("shop_id", shop.shopId).select()).error, `${name} delete ${table}`).not.toBeNull()
        }
      }
      for (const table of ["commercial_membership_events", "commercial_membership_coverage"]) {
        expect((await db.from(table).insert({ shop_id: shop.shopId }).select()).error, `service insert ${table}`).not.toBeNull()
        expect((await db.from(table).update({ shop_id: shop.shopId }).eq("shop_id", shop.shopId).select()).error, `service update ${table}`).not.toBeNull()
        expect((await db.from(table).delete().eq("shop_id", shop.shopId).select()).error, `service delete ${table}`).not.toBeNull()
      }
      expect((await events(shop.shopId))[0].id).toBe(anyEvent.id)
    })

    it("lets browser roles run neither the capture helpers nor the correction writer", async () => {
      const target = (await events(shop.shopId))[0]
      const correction = {
        p_shop: shop.shopId, p_user_id: target.user_id, p_effective_at: target.effective_at, p_billable: false,
        p_corrects_event_id: target.id, p_reason: "x", p_idempotency_key: "k".repeat(24),
      }
      for (const [name, client] of [["owner", owner], ["manager", mgr], ["staff", stf], ["anon", anonClient()], ["cross-shop", otherOwner]] as const) {
        const r = await client.rpc("commercial_membership_correct", correction)
        expect(r.error, name).not.toBeNull()
        const emit = await client.rpc("commercial_membership_emit", {
          p_shop: shop.shopId, p_user: target.user_id, p_member: null, p_prev_role: null, p_prev_active: null,
          p_new_role: "staff", p_new_active: true, p_operation: "membership_insert",
        })
        expect(emit.error, name).not.toBeNull()
      }
      const emitAsService = await db.rpc("commercial_membership_emit", {
        p_shop: shop.shopId, p_user: target.user_id, p_member: null, p_prev_role: null, p_prev_active: null,
        p_new_role: "staff", p_new_active: true, p_operation: "membership_insert",
      })
      expect(emitAsService.error).not.toBeNull()
    })
  })

  describe("corrections", () => {
    it("append a traceable compensating fact, replay safely, and refuse unsound input", async () => {
      const t = await newShop()
      const member = await newShop()
      await addMember(t.shopId, member, "staff")
      const target = (await events(t.shopId)).find((r) => r.user_id === member.ownerId)!
      const before = (await db.from("shop_memberships").select("*").eq("shop_id", t.shopId).eq("user_id", member.ownerId).single()).data
      const input = {
        shopId: t.shopId, userId: member.ownerId, effectiveAt: target.effective_at, billable: false,
        correctsEventId: target.id, reason: "read-only contractor, not a billable operator", correctionRef: "ticket-1",
      }
      const first = await correctMembershipBilling(db, input)
      expect(first).toMatchObject({ ok: true, replayed: false })
      const again = await correctMembershipBilling(db, input)
      expect(again).toMatchObject({ ok: true, replayed: true })
      if (first.ok && again.ok) expect(again.id).toBe(first.id)
      expect(await correctMembershipBilling(db, { ...input, reason: "different reason" })).toMatchObject({ ok: false, reason: "conflict" })
      expect(await correctMembershipBilling(db, { ...input, billable: true })).toMatchObject({ ok: false, reason: "conflict" })

      const row = (await events(t.shopId)).find((r) => r.kind === "correction")!
      expect(row).toMatchObject({
        user_id: member.ownerId, corrects_event_id: target.id, previous_billable: true, new_billable: false,
        new_role: null, new_active: null, source_operation: "billing_correction",
      })
      // Prior history is untouched and the membership itself is not edited.
      expect((await events(t.shopId)).find((r) => r.id === target.id)?.new_billable).toBe(true)
      expect((await db.from("shop_memberships").select("*").eq("shop_id", t.shopId).eq("user_id", member.ownerId).single()).data).toEqual(before)

      const unknown = await correctMembershipBilling(db, { ...input, correctionRef: "t2", correctsEventId: "99999999-9999-4999-8999-999999999999" })
      expect(unknown).toMatchObject({ ok: false, reason: "invalid" })
      const wrongUser = await correctMembershipBilling(db, { ...input, correctionRef: "t3", userId: t.ownerId })
      expect(wrongUser).toMatchObject({ ok: false, reason: "invalid" })
      const crossShop = await correctMembershipBilling(db, { ...input, correctionRef: "t4", shopId: shop.shopId })
      expect(crossShop).toMatchObject({ ok: false, reason: "invalid" })
      const beforeCoverage = await correctMembershipBilling(db, {
        ...input, correctionRef: "t5", effectiveAt: new Date(Date.parse((await coverage(t.shopId))!.covered_from) - DAY).toISOString(),
      })
      expect(beforeCoverage).toMatchObject({ ok: false, reason: "invalid" })
      const future = await correctMembershipBilling(db, { ...input, correctionRef: "t6", effectiveAt: new Date(Date.now() + DAY).toISOString() })
      expect(future).toMatchObject({ ok: false, reason: "invalid" })
      assertConsistent(await events(t.shopId))
    })

    it("creates exactly one correction under concurrent identical requests", async () => {
      const t = await newShop()
      const target = (await events(t.shopId))[0]
      const input = {
        shopId: t.shopId, userId: t.ownerId, effectiveAt: target.effective_at, billable: false,
        correctsEventId: target.id, reason: "concurrent probe", correctionRef: "race",
      }
      const results = await Promise.all(Array.from({ length: 8 }, () => correctMembershipBilling(db, input)))
      expect(results.every((r) => r.ok)).toBe(true)
      expect(new Set(results.map((r) => (r.ok ? r.id : ""))).size).toBe(1)
      expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1)
      expect((await events(t.shopId)).filter((r) => r.kind === "correction")).toHaveLength(1)
    })
  })

  describe("period preview from recorded history", () => {
    it("computes exact extra-seat proration for a closed, covered period and keeps usage unchanged", async () => {
      const t = await newShop(true)
      const people = await Promise.all([1, 2, 3, 4].map(() => newShop()))
      await addMember(t.shopId, people[0], "manager")
      await addMember(t.shopId, people[1], "staff")
      const extraA = await addMember(t.shopId, people[2], "staff")
      await addMember(t.shopId, people[3], "manager")
      const session = await ownerSessionClient(t.email, PW)
      // owner + manager + staff + staff + manager = 5 billable operators = 2 extra seats.
      const window = { shopId: t.shopId, windowStart: midnight(1), windowEnd: midnight(3), asOf: FUTURE_AS_OF() }
      const read = await readCommercialPeriodPreview(session, window)
      if (read.status !== "ready" || read.preview.state !== "ok") throw new Error(JSON.stringify(read))
      expect(read.preview.subscription.seatProration).toMatchObject({
        state: "computed", daysInPeriod: 2, extraSeatDays: 4, numerator: 4 * 3900, denominator: 2, roundedCents: 7800,
      })
      expect(read.preview.subscription.invoiceTotal).toEqual({
        state: "available", baseCents: 19_900, seatCents: 7800, usageCents: 0, totalCents: 19_900 + 7800,
      })

      // Deactivating one operator changes the next preview; the earlier events remain in history.
      expect((await setMember(extraA, { active: false })).error).toBeNull()
      const after = await readCommercialPeriodPreview(session, { ...window, asOf: FUTURE_AS_OF() })
      if (after.status !== "ready" || after.preview.state !== "ok") throw new Error("expected ok")
      expect(after.preview.subscription.seatProration).toMatchObject({ extraSeatDays: 2, roundedCents: 3900 })

      // Usage-only preview (PR A behavior) is unchanged and keeps seats unavailable.
      const usageOnly = await readCommercialUsagePreview(session, window)
      if (usageOnly.status !== "ready" || usageOnly.preview.state !== "ok") throw new Error("expected ok")
      expect(usageOnly.preview.subscription.seatProration).toMatchObject({ code: "no_membership_evidence" })
      expect(JSON.stringify(usageOnly.preview.usage)).toBe(JSON.stringify(after.preview.usage))
    })

    it("reports the exact uncovered span, never zero, for a period that starts before coverage", async () => {
      const t = await newShop(true)
      const session = await ownerSessionClient(t.email, PW)
      const covered = (await coverage(t.shopId))!.covered_from
      const read = await readCommercialPeriodPreview(session, {
        shopId: t.shopId, windowStart: midnight(0), windowEnd: midnight(1), asOf: FUTURE_AS_OF(),
      })
      if (read.status !== "ready" || read.preview.state !== "ok") throw new Error("expected ok")
      const seats = read.preview.subscription.seatProration
      expect(seats.state).toBe("seat_proration_unavailable")
      if (seats.state === "seat_proration_unavailable") {
        expect(seats.code).toBe("coverage_gap")
        expect(seats.gap?.start).toBe(midnight(0))
        expect(Date.parse(seats.gap!.end)).toBe(Date.parse(covered))
      }
      expect(read.preview.subscription.invoiceTotal.state).toBe("unavailable")
      expect(JSON.stringify(read.preview.subscription)).not.toContain('"roundedCents"')
    })

    it("withholds seats for a period that has not closed at the evidence instant", async () => {
      const t = await newShop(true)
      const session = await ownerSessionClient(t.email, PW)
      const read = await readCommercialPeriodPreview(session, { shopId: t.shopId, windowStart: midnight(1), windowEnd: midnight(2) })
      if (read.status !== "ready" || read.preview.state !== "ok") throw new Error("expected ok")
      expect(read.preview.subscription.seatProration).toMatchObject({ code: "period_not_closed" })
    })

    it("never claims a shop with no recorded coverage", async () => {
      const t = await newShop(true)
      const session = await ownerSessionClient(t.email, PW)
      // As of an instant before the shop existed there is no recorded coverage at all.
      const read = await readCommercialPeriodPreview(session, {
        shopId: t.shopId, windowStart: midnight(-30), windowEnd: midnight(-29), asOf: new Date(Date.now() - 10 * DAY).toISOString(),
      })
      if (read.status !== "ready" || read.preview.state !== "ok") throw new Error("expected ok")
      expect(read.preview.subscription.seatProration).toMatchObject({ code: "no_coverage" })
    })
  })

  it("follows the tenant-deletion contract: deleting a shop removes its history, nothing else can", async () => {
    const doomed = await newShop()
    const member = await newShop()
    await addMember(doomed.shopId, member, "staff")
    const target = (await events(doomed.shopId))[0]
    expect((await correctMembershipBilling(db, {
      shopId: doomed.shopId, userId: doomed.ownerId, effectiveAt: target.effective_at, billable: true,
      correctsEventId: target.id, reason: "probe", correctionRef: "bye",
    })).ok).toBe(true)
    expect((await events(doomed.shopId)).length).toBeGreaterThan(2)
    expect((await db.from("commercial_membership_events").delete().eq("shop_id", doomed.shopId)).error).not.toBeNull()
    await cleanup(db, doomed)
    expect(await events(doomed.shopId)).toEqual([])
    expect(await coverage(doomed.shopId)).toBeNull()
  })
})
