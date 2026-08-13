import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  claimProviderEvent,
  completeProviderEvent,
  failProviderEvent,
} from "@/lib/provider-events"
import {
  INTEGRATION,
  INTEGRATION_WITH_SESSION,
  anonClient,
  serviceClient,
  seedShop,
  cleanup,
  type Seeded,
} from "./_db"

/**
 * P0-005 (ADR-001) — the central provider_events claim mechanism against
 * REAL Postgres: the proofs a mock can't give. Concurrency uses separate
 * supabase-js clients (separate connections) and actual Promise.all — never
 * sequential simulation. Providers/routes are NOT wired here (P0-006/007);
 * this suite locks the mechanism those tickets consume.
 */

const OWNER_PASSWORD = "int-p0005-Passw0rd!"

let sb: SupabaseClient
let sb2: SupabaseClient // separate connection for real concurrency
let seed: Seeded

/** Unique event id per test run so reruns never collide. */
const eid = (label: string) =>
  `${label}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`

async function getRow(provider: string, eventId: string) {
  const { data } = await sb
    .from("provider_events")
    .select("*")
    .eq("provider", provider)
    .eq("event_id", eventId)
    .maybeSingle()
  return data as
    | {
        id: string
        status: string
        attempts: number
        shop_id: string | null
        last_error: string | null
        metadata: Record<string, unknown>
      }
    | null
}

describe.skipIf(!INTEGRATION)("provider_events claims [integration]", () => {
  beforeAll(async () => {
    sb = serviceClient()
    sb2 = serviceClient()
    seed = await seedShop(sb, { password: OWNER_PASSWORD })
  })

  afterAll(async () => {
    if (sb && seed) {
      await sb.from("provider_events").delete().eq("shop_id", seed.shopId)
      await cleanup(sb, seed)
    }
  })

  it("first delivery claims; the claim row is durable and shop-scoped", async () => {
    const id = eid("SM-first")
    const claim = await claimProviderEvent(sb, {
      provider: "twilio",
      eventId: id,
      shopId: seed.shopId,
      metadata: { source: "int-test" },
    })
    expect(claim.outcome).toBe("claimed")
    expect(claim.shouldProcess).toBe(true)
    expect(claim.attempts).toBe(1)

    const row = await getRow("twilio", id)
    expect(row?.status).toBe("processing")
    expect(row?.shop_id).toBe(seed.shopId)
    expect(row?.metadata).toEqual({ source: "int-test" })
  })

  it("duplicate after completion is a no-op and stays durable across new clients", async () => {
    const id = eid("SM-completed")
    await claimProviderEvent(sb, { provider: "twilio", eventId: id, shopId: seed.shopId })
    expect(await completeProviderEvent(sb, "twilio", id)).toBe(true)

    // A brand-new client (new process/instance in production) sees the same
    // durable decision — nothing lives in process memory.
    const fresh = serviceClient()
    const dup = await claimProviderEvent(fresh, {
      provider: "twilio",
      eventId: id,
      shopId: seed.shopId,
    })
    expect(dup.outcome).toBe("duplicate_completed")
    expect(dup.shouldProcess).toBe(false)

    const row = await getRow("twilio", id)
    expect(row?.status).toBe("completed")
    expect(row?.attempts).toBe(1) // duplicates never bump a completed claim
  })

  it("duplicate while the original is processing cannot execute", async () => {
    const id = eid("SM-processing")
    const first = await claimProviderEvent(sb, {
      provider: "twilio",
      eventId: id,
      shopId: seed.shopId,
    })
    expect(first.outcome).toBe("claimed")

    const dup = await claimProviderEvent(sb2, {
      provider: "twilio",
      eventId: id,
      shopId: seed.shopId,
    })
    expect(dup.outcome).toBe("duplicate_processing")
    expect(dup.shouldProcess).toBe(false)
  })

  it("two genuinely concurrent identical deliveries → exactly one winner", async () => {
    // Stressed: many rounds, two separate connections, real Promise.all.
    for (let round = 0; round < 10; round++) {
      const id = eid(`SM-race-${round}`)
      const [a, b] = await Promise.all([
        claimProviderEvent(sb, { provider: "twilio", eventId: id, shopId: seed.shopId }),
        claimProviderEvent(sb2, { provider: "twilio", eventId: id, shopId: seed.shopId }),
      ])
      const winners = [a, b].filter((c) => c.shouldProcess)
      expect(winners).toHaveLength(1)
      const losers = [a, b].filter((c) => !c.shouldProcess)
      expect(losers[0].outcome).toBe("duplicate_processing")
    }
  })

  it("handler failure records a durable, observable failure — never silently successful", async () => {
    const id = eid("SM-fail")
    await claimProviderEvent(sb, { provider: "twilio", eventId: id, shopId: seed.shopId })
    expect(
      await failProviderEvent(sb, "twilio", id, new Error("classifier exploded"))
    ).toBe(true)

    const row = await getRow("twilio", id)
    expect(row?.status).toBe("failed")
    expect(row?.last_error).toBe("classifier exploded")
  })

  it("re-delivery after failure reclaims for retry (explicit policy), attempts increment", async () => {
    const id = eid("SM-retry")
    await claimProviderEvent(sb, { provider: "twilio", eventId: id, shopId: seed.shopId })
    await failProviderEvent(sb, "twilio", id, new Error("transient"))

    const retry = await claimProviderEvent(sb2, {
      provider: "twilio",
      eventId: id,
      shopId: seed.shopId,
    })
    expect(retry.outcome).toBe("reclaimed_failed")
    expect(retry.shouldProcess).toBe(true)
    expect(retry.attempts).toBe(2)

    // retryFailed: false → failed rows stay closed
    await failProviderEvent(sb, "twilio", id, new Error("still broken"))
    const closed = await claimProviderEvent(sb, {
      provider: "twilio",
      eventId: id,
      shopId: seed.shopId,
      retryFailed: false,
    })
    expect(closed.outcome).toBe("duplicate_failed")
    expect(closed.shouldProcess).toBe(false)
  })

  it("a crashed claimer is reclaimable once stale — no event is permanently stranded", async () => {
    const id = eid("SM-stale")
    await claimProviderEvent(sb, { provider: "twilio", eventId: id, shopId: seed.shopId })
    // Simulate a crash long ago: age the claim (service-role test fixture —
    // production code never rewinds last_attempt_at).
    await sb
      .from("provider_events")
      .update({ last_attempt_at: new Date(Date.now() - 3600_000).toISOString() })
      .eq("provider", "twilio")
      .eq("event_id", id)

    const takeover = await claimProviderEvent(sb2, {
      provider: "twilio",
      eventId: id,
      shopId: seed.shopId,
      staleAfterSeconds: 300,
    })
    expect(takeover.outcome).toBe("reclaimed_stale")
    expect(takeover.shouldProcess).toBe(true)
    expect(takeover.attempts).toBe(2)

    // ...but a FRESH processing claim is never stolen.
    const id2 = eid("SM-fresh")
    await claimProviderEvent(sb, { provider: "twilio", eventId: id2, shopId: seed.shopId })
    const noSteal = await claimProviderEvent(sb2, {
      provider: "twilio",
      eventId: id2,
      shopId: seed.shopId,
      staleAfterSeconds: 300,
    })
    expect(noSteal.outcome).toBe("duplicate_processing")
  })

  it("processing state is never mistaken for completed", async () => {
    const id = eid("SM-not-done")
    await claimProviderEvent(sb, { provider: "twilio", eventId: id, shopId: seed.shopId })
    // complete() only flips processing rows it matches; a second complete
    // returns false rather than inventing success.
    expect(await completeProviderEvent(sb, "twilio", id)).toBe(true)
    expect(await completeProviderEvent(sb, "twilio", id)).toBe(false)
    // fail() can never flip a completed row back.
    expect(await failProviderEvent(sb, "twilio", id, new Error("late"))).toBe(false)
    expect((await getRow("twilio", id))?.status).toBe("completed")
  })

  it("same raw id from two providers does not collide; different ids are independent", async () => {
    const raw = eid("shared-raw")
    const [a, b] = await Promise.all([
      claimProviderEvent(sb, { provider: "twilio", eventId: raw, shopId: seed.shopId }),
      claimProviderEvent(sb2, { provider: "vapi", eventId: raw, shopId: seed.shopId }),
    ])
    expect(a.outcome).toBe("claimed")
    expect(b.outcome).toBe("claimed")

    const other = await claimProviderEvent(sb, {
      provider: "twilio",
      eventId: eid("SM-other"),
      shopId: seed.shopId,
    })
    expect(other.outcome).toBe("claimed")
  })

  it("tenant A's event never blocks tenant B's (namespaced ids per contract)", async () => {
    const seedB = await seedShop(sb)
    try {
      // Aurinko-style per-account ids, namespaced per the module contract.
      const rawMessageId = `msg-${Date.now()}`
      const [a, b] = await Promise.all([
        claimProviderEvent(sb, {
          provider: "aurinko",
          eventId: `acct-A:${rawMessageId}`,
          shopId: seed.shopId,
        }),
        claimProviderEvent(sb2, {
          provider: "aurinko",
          eventId: `acct-B:${rawMessageId}`,
          shopId: seedB.shopId,
        }),
      ])
      expect(a.outcome).toBe("claimed")
      expect(b.outcome).toBe("claimed")
    } finally {
      await sb.from("provider_events").delete().eq("shop_id", seedB.shopId)
      await cleanup(sb, seedB)
    }
  })

  it("an event whose tenant cannot be resolved still dedupes (shop_id null)", async () => {
    const id = eid("SM-no-tenant")
    const first = await claimProviderEvent(sb, { provider: "twilio", eventId: id })
    expect(first.outcome).toBe("claimed")
    const dup = await claimProviderEvent(sb2, { provider: "twilio", eventId: id })
    expect(dup.shouldProcess).toBe(false)
    // Later delivery that CAN resolve the tenant backfills it on reclaim.
    await failProviderEvent(sb, "twilio", id, new Error("no shop"))
    const retry = await claimProviderEvent(sb, {
      provider: "twilio",
      eventId: id,
      shopId: seed.shopId,
    })
    expect(retry.outcome).toBe("reclaimed_failed")
    expect((await getRow("twilio", id))?.shop_id).toBe(seed.shopId)
    // Tidy the null-tenant leftovers this test created.
    await completeProviderEvent(sb, "twilio", id)
  })

  it("malformed events are rejected, never a successful receipt; DB errors fail closed", async () => {
    await expect(
      claimProviderEvent(sb, { provider: "twilio", eventId: "" })
    ).rejects.toThrow(/claim failed/)
    // Nothing was recorded.
    const { count } = await sb
      .from("provider_events")
      .select("*", { count: "exact", head: true })
      .eq("event_id", "")
    expect(count ?? 0).toBe(0)

    // A failing DB surface throws (fail closed) — the caller must never
    // process unguarded. Oversized event_id trips the length CHECK.
    await expect(
      claimProviderEvent(sb, { provider: "twilio", eventId: "x".repeat(600) })
    ).rejects.toThrow(/claim failed/)
  })

  it("error text is truncated and secret-free; metadata stores only what callers pass", async () => {
    const id = eid("SM-sanitize")
    await claimProviderEvent(sb, {
      provider: "twilio",
      eventId: id,
      shopId: seed.shopId,
      metadata: { attempt_note: "retry after 429" },
    })
    await failProviderEvent(sb, "twilio", id, new Error("boom ".repeat(400)))
    const row = await getRow("twilio", id)
    expect(row?.last_error?.length).toBeLessThanOrEqual(500)
    // The receipt holds exactly the safe keys passed — no payloads, no
    // headers, no signatures snuck in by the mechanism itself.
    expect(Object.keys(row?.metadata ?? {})).toEqual(["attempt_note"])
  })
})

describe.skipIf(!INTEGRATION_WITH_SESSION)(
  "provider_events permissions [integration]",
  () => {
    beforeAll(async () => {
      sb = serviceClient()
      seed = await seedShop(sb, { password: OWNER_PASSWORD })
    })

    afterAll(async () => {
      if (sb && seed) {
        await sb.from("provider_events").delete().eq("shop_id", seed.shopId)
        await cleanup(sb, seed)
      }
    })

    it("an unauthenticated sender can neither insert claims nor call the RPCs (no poisoning)", async () => {
      const anon = anonClient()
      const insert = await anon.from("provider_events").insert({
        provider: "twilio",
        event_id: "SM-poison-attempt",
        status: "completed", // a poisoner would pre-complete a real sid
      })
      expect(insert.error).toBeTruthy()

      const rpc = await anon.rpc("claim_provider_event", {
        p_provider: "twilio",
        p_event_id: "SM-poison-attempt",
        p_shop_id: null,
        p_metadata: {},
        p_stale_after_seconds: 300,
        p_retry_failed: true,
      })
      expect(rpc.error).toBeTruthy()

      // The legitimate event is untouched and still claimable.
      const real = await claimProviderEvent(sb, {
        provider: "twilio",
        eventId: "SM-poison-attempt",
        shopId: seed.shopId,
      })
      expect(real.outcome).toBe("claimed")
      await completeProviderEvent(sb, "twilio", "SM-poison-attempt")
      await sb
        .from("provider_events")
        .delete()
        .eq("provider", "twilio")
        .eq("event_id", "SM-poison-attempt")
    })

    it("an authenticated owner session cannot read or write claims either", async () => {
      const { ownerSessionClient } = await import("./_db")
      const session = await ownerSessionClient(seed.email, OWNER_PASSWORD)
      try {
        const insert = await session.from("provider_events").insert({
          provider: "twilio",
          event_id: "SM-owner-poison",
          shop_id: seed.shopId,
        })
        expect(insert.error).toBeTruthy()

        const rpc = await session.rpc("claim_provider_event", {
          p_provider: "twilio",
          p_event_id: "SM-owner-poison",
          p_shop_id: seed.shopId,
          p_metadata: {},
          p_stale_after_seconds: 300,
          p_retry_failed: true,
        })
        expect(rpc.error).toBeTruthy()

        // Deny-all RLS: reads return no rows.
        await claimProviderEvent(sb, {
          provider: "twilio",
          eventId: "SM-owner-read",
          shopId: seed.shopId,
        })
        const { data } = await session
          .from("provider_events")
          .select("id")
          .eq("shop_id", seed.shopId)
        expect(data ?? []).toHaveLength(0)
      } finally {
        await session.auth.signOut()
      }
    })
  }
)
