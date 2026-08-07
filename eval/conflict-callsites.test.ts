import { afterEach, describe, expect, it, vi } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import * as availability from "@/lib/availability"
import type { AvailabilityConflict } from "@/lib/availability"
import { blockTime, rescheduleJob } from "@/app/actions/jobs"
import { respondToQuote } from "@/app/actions/quote-response"
import { recordInteraction } from "@/lib/memory"

/**
 * P0-004 — owner-direct call sites (drag-reschedule, block-time) and the
 * quote-accept staging path. Owner-direct moves are HITL (D-016): blocking
 * conflicts return structured info for the warn-confirm dialog; the retry
 * carries a required reason and the override is recorded with actor +
 * timestamp. Quote accept attaches the advisory snapshot to the card.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

vi.mock("@/lib/shop", () => ({
  requireShop: vi.fn(async () => ({ id: "shop-1", name: "Test Shop" })),
  requireUser: vi.fn(async () => ({ id: "owner-1", email: "o@x.test" })),
}))

vi.mock("@/lib/memory", () => ({
  recordInteraction: vi.fn(async () => ({ ok: true, id: "int-1", embedded: false })),
}))

vi.mock("@/lib/pipeline", () => ({
  moveLeadToStage: vi.fn(async () => undefined),
  stageFromLegacyStatus: vi.fn(),
}))

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }))
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: vi.fn() }))

vi.mock("@/lib/availability", async (importOriginal) => {
  const original = await importOriginal<typeof availability>()
  return {
    ...original,
    stagingAvailability: vi.fn(async () => ({ summary: null, blocking: [] })),
  }
})

const mockedStaging = vi.mocked(availability.stagingAvailability)
const mockedRecordInteraction = vi.mocked(recordInteraction)

const START = "2030-01-01T17:00:00.000Z"

function conflict(id: string): AvailabilityConflict {
  return {
    source: "appointment",
    id,
    start: START,
    end: "2030-01-01T19:00:00.000Z",
    label: `Existing Full Detail (${id})`,
    blockTime: false,
    resource: null,
    severity: "blocking",
    metadata: {},
  }
}

function summaryFor(...conflicts: AvailabilityConflict[]) {
  return availability.summarizeAvailability(
    {
      available: conflicts.length === 0,
      conflicts,
      calendar: "unchecked",
      calendarUncheckedReason: "not_connected",
      range: { start: START, end: "2030-01-01T19:00:00.000Z" },
      excludedAppointmentId: null,
      override: null,
    },
    "2030-01-01T00:00:00.000Z"
  )
}

// Recording client for the jobs actions.
type Write = { table: string; op: "insert" | "update"; values: Record<string, unknown> }

function jobsDb(opts: { job?: Record<string, unknown> | null; writes?: Write[] }) {
  const writes = opts.writes ?? []
  const client = {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      for (const m of ["select", "eq", "gte", "lt", "order", "limit", "or"]) {
        chain[m] = () => chain
      }
      chain.maybeSingle = () =>
        Promise.resolve({
          data: table === "appointments" ? (opts.job ?? null) : null,
          error: null,
        })
      chain.single = () => Promise.resolve({ data: { id: "new-row" }, error: null })
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ data: null, error: null }))
      return {
        ...chain,
        update: (values: Record<string, unknown>) => {
          writes.push({ table, op: "update", values })
          return chain
        },
        insert: (values: Record<string, unknown>) => {
          writes.push({ table, op: "insert", values })
          return {
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: "new-row" }, error: null }),
            }),
          }
        },
      }
    },
  } as unknown as SupabaseClient
  return { client, writes }
}

const jobRow = {
  id: "job-1",
  shop_id: "shop-1",
  customer_id: "cust-1",
  service_name: "Full Detail",
  duration_minutes: 120,
  scheduled_at: "2030-01-01T10:00:00.000Z",
  ends_at: null,
  aurinko_event_id: null,
  aurinko_calendar_id: null,
  timezone: null,
  customer: null,
}

afterEach(() => {
  vi.clearAllMocks()
  mockedStaging.mockResolvedValue({ summary: null, blocking: [], failure: null })
})

describe("rescheduleJob (owner drag) — warn, then documented override", () => {
  it("blocking conflict without a reason → structured refusal, nothing written", async () => {
    const blocking = [conflict("appt-9")]
    mockedStaging.mockResolvedValue({ summary: summaryFor(...blocking), blocking, failure: null })
    const { client, writes } = jobsDb({ job: jobRow })
    const { createClient } = await import("@/lib/supabase/server")
    vi.mocked(createClient).mockResolvedValue(client as never)

    const result = await rescheduleJob("job-1", START)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.conflict?.labels).toEqual(["Existing Full Detail (appt-9)"])
    expect(writes.filter((w) => w.table === "appointments")).toHaveLength(0)
  })

  it("passes self-exclusion so a small nudge never trips on its own slot", async () => {
    const { client } = jobsDb({ job: jobRow })
    const { createClient } = await import("@/lib/supabase/server")
    vi.mocked(createClient).mockResolvedValue(client as never)

    await rescheduleJob("job-1", START)
    expect(mockedStaging).toHaveBeenCalledWith(
      expect.anything(),
      "shop-1",
      expect.objectContaining({ excludeAppointmentId: "job-1" })
    )
  })

  it("with a reason → moves the job and records the override (actor, timestamp, conflicts)", async () => {
    const blocking = [conflict("appt-9")]
    mockedStaging.mockResolvedValue({ summary: summaryFor(...blocking), blocking, failure: null })
    const { client, writes } = jobsDb({ job: jobRow })
    const { createClient } = await import("@/lib/supabase/server")
    vi.mocked(createClient).mockResolvedValue(client as never)

    const result = await rescheduleJob("job-1", START, {
      overrideReason: "Customer asked to double up",
    })
    expect(result.ok).toBe(true)
    const move = writes.find(
      (w) => w.table === "appointments" && w.op === "update"
    )
    expect(move?.values.scheduled_at).toBe(START)
    expect(move?.values.ends_at).toBeTruthy()

    const overrideNote = mockedRecordInteraction.mock.calls.find(
      ([, input]) =>
        (input.metadata as { kind?: string } | undefined)?.kind ===
        "conflict_override"
    )
    expect(overrideNote).toBeDefined()
    const meta = overrideNote?.[1].metadata as Record<string, unknown>
    expect(meta.overridden_by).toBe("owner-1")
    expect(typeof meta.overridden_at).toBe("string")
    expect(meta.reason).toBe("Customer asked to double up")
    expect(meta.conflicts).toEqual(["appointment:appt-9"])
  })

  it("clear slot → moves without any override ceremony", async () => {
    const { client, writes } = jobsDb({ job: jobRow })
    const { createClient } = await import("@/lib/supabase/server")
    vi.mocked(createClient).mockResolvedValue(client as never)

    const result = await rescheduleJob("job-1", START)
    expect(result.ok).toBe(true)
    expect(writes.some((w) => w.table === "appointments")).toBe(true)
    expect(
      mockedRecordInteraction.mock.calls.some(
        ([, input]) =>
          (input.metadata as { kind?: string } | undefined)?.kind ===
          "conflict_override"
      )
    ).toBe(false)
  })
})

describe("owner-direct paths fail CLOSED on an internal check failure (founder policy)", () => {
  function failedStaging() {
    mockedStaging.mockResolvedValue({
      summary: availability.unverifiedAvailabilitySummary(
        "2030-01-01T00:00:00.000Z",
        "appointments_query_failed"
      ),
      blocking: [],
      failure: "appointments_query_failed",
    })
  }

  it("rescheduleJob: internal failure → refused, nothing written, marked unverified", async () => {
    failedStaging()
    const { client, writes } = jobsDb({ job: jobRow })
    const { createClient } = await import("@/lib/supabase/server")
    vi.mocked(createClient).mockResolvedValue(client as never)

    const result = await rescheduleJob("job-1", START)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error).toContain("Couldn't verify")
    expect(result.conflict).toEqual({ labels: [], keys: [], unverified: true })
    expect(writes.filter((w) => w.table === "appointments")).toHaveLength(0)
  })

  it("rescheduleJob: an override reason does NOT bypass a verification failure", async () => {
    failedStaging()
    const { client, writes } = jobsDb({ job: jobRow })
    const { createClient } = await import("@/lib/supabase/server")
    vi.mocked(createClient).mockResolvedValue(client as never)

    const result = await rescheduleJob("job-1", START, {
      overrideReason: "I insist",
    })
    expect(result.ok).toBe(false)
    expect(writes.filter((w) => w.table === "appointments")).toHaveLength(0)
    // No override was recorded — there were no conflicts to override.
    expect(
      mockedRecordInteraction.mock.calls.some(
        ([, input]) =>
          (input.metadata as { kind?: string } | undefined)?.kind ===
          "conflict_override"
      )
    ).toBe(false)
  })

  it("blockTime: internal failure → refused even with a reason; no insert", async () => {
    failedStaging()
    const { client, writes } = jobsDb({ job: null })
    const { createClient } = await import("@/lib/supabase/server")
    vi.mocked(createClient).mockResolvedValue(client as never)

    const result = await blockTime(START, 60, "Lunch", {
      overrideReason: "I insist",
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.conflict?.unverified).toBe(true)
    expect(writes.filter((w) => w.op === "insert")).toHaveLength(0)
  })
})

describe("blockTime — same gate, same recorded override", () => {
  it("blocking conflict without a reason → refusal with labels; no insert", async () => {
    const blocking = [conflict("appt-3")]
    mockedStaging.mockResolvedValue({ summary: summaryFor(...blocking), blocking, failure: null })
    const { client, writes } = jobsDb({ job: null })
    const { createClient } = await import("@/lib/supabase/server")
    vi.mocked(createClient).mockResolvedValue(client as never)

    const result = await blockTime(START, 60, "Lunch")
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.conflict?.labels).toHaveLength(1)
    expect(writes.filter((w) => w.op === "insert")).toHaveLength(0)
  })

  it("with a reason → block lands and the override is recorded", async () => {
    const blocking = [conflict("appt-3")]
    mockedStaging.mockResolvedValue({ summary: summaryFor(...blocking), blocking, failure: null })
    const { client, writes } = jobsDb({ job: null })
    const { createClient } = await import("@/lib/supabase/server")
    vi.mocked(createClient).mockResolvedValue(client as never)

    const result = await blockTime(START, 60, "Emergency hold", {
      overrideReason: "Truck broke down — holding the bay",
    })
    expect(result.ok).toBe(true)
    const insert = writes.find(
      (w) => w.table === "appointments" && w.op === "insert"
    )
    expect(insert?.values.internal_note).toBe("[block-time]")
    expect(
      mockedRecordInteraction.mock.calls.some(
        ([, input]) =>
          (input.metadata as { kind?: string } | undefined)?.kind ===
          "conflict_override"
      )
    ).toBe(true)
  })
})

describe("quote accept — advisory snapshot rides the staged card", () => {
  it("attaches availability to the book_appointment payload", async () => {
    const blocking = [conflict("appt-7")]
    const summary = summaryFor(...blocking)
    mockedStaging.mockResolvedValue({ summary, blocking, failure: null })

    const inserts: Record<string, unknown>[] = []
    const quoteRow = {
      id: "quote-1",
      shop_id: "shop-1",
      status: "viewed",
      responded_at: null,
      lead_id: null,
      customer_id: "cust-1",
      total_cents: 45000,
      line_items: [{ name: "Ceramic Coating" }],
      shops: { id: "shop-1", name: "Test Shop", owner_id: "owner-1", voice_config: null },
      customers: {
        id: "cust-1",
        name: "Sam",
        phone: "+15035550101",
        email: "sam@x.test",
      },
    }
    const service = {
      from: (table: string) => {
        const chain: Record<string, unknown> = {}
        for (const m of ["select", "eq", "gte", "lt", "order", "limit", "or", "in"]) {
          chain[m] = () => chain
        }
        chain.maybeSingle = () =>
          Promise.resolve({
            data: table === "quotes" ? quoteRow : null,
            error: null,
          })
        chain.single = () => Promise.resolve({ data: { id: "pa-new" }, error: null })
        chain.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve(resolve({ data: null, error: null }))
        return {
          ...chain,
          update: () => chain,
          insert: (row: Record<string, unknown>) => {
            if (table === "pending_actions") inserts.push(row)
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({ data: { id: "pa-new" }, error: null }),
              }),
            }
          },
        }
      },
    } as unknown as SupabaseClient

    const { createServiceClient } = await import("@/lib/supabase/service")
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const result = await respondToQuote("tok-1234567890123456", "accept", START)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.bookingStaged).toBe(true)
    expect(inserts).toHaveLength(1)
    const payload = inserts[0].payload as Record<string, unknown>
    expect(payload.availability).toEqual(summary)
  })
})
