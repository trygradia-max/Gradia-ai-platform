import { afterEach, describe, it, expect, vi } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import { ALWAYS_HITL, isAutonomyAllowed } from "@/lib/autonomy"
import { cancelAppointment, rescheduleAppointment } from "@/lib/vapi-tools"
import { VOICE_TOOL_DEFINITIONS } from "@/lib/voice-provider"

/**
 * Tier 1 — pure, deterministic, no API. Eval cases for the voice
 * reschedule/cancel tools (work order item 2): both are calendar writes →
 * ALWAYS_HITL floor; handlers STAGE pending_actions and never touch the
 * appointments table or the calendar themselves.
 */

describe("HITL floor — reschedule/cancel join book/charge", () => {
  it("neither can ever auto-execute, in any autonomy mode", () => {
    expect(isAutonomyAllowed("reschedule_appointment")).toBe(false)
    expect(isAutonomyAllowed("cancel_appointment")).toBe(false)
    expect(ALWAYS_HITL.has("reschedule_appointment")).toBe(true)
    expect(ALWAYS_HITL.has("cancel_appointment")).toBe(true)
  })

  it("the tools tell the model approval is required, in the description", () => {
    for (const name of ["reschedule_appointment", "cancel_appointment"]) {
      const tool = VOICE_TOOL_DEFINITIONS.find((t) => t.function.name === name)
      expect(tool, `${name} must be declared`).toBeDefined()
      expect(tool?.function.description).toContain("human approval")
    }
  })
})

describe("handlers stage approvals — never execute", () => {
  type Insert = { table: string; row: Record<string, unknown> }

  function mockSupabase(opts: {
    appointment?: { id: string; scheduled_at: string; service_name: string | null } | null
    inserts: Insert[]
  }): SupabaseClient {
    // Self-returning query chain; terminals resolve by table.
    const chainFor = (table: string) => {
      const terminalData = () => {
        if (table === "customers") return { id: "cust-1" }
        if (table === "appointments") return opts.appointment ?? null
        if (table === "shops") return { owner_id: "owner-1" }
        return null
      }
      const chain: Record<string, unknown> = {}
      for (const m of ["select", "eq", "gte", "order", "limit"]) {
        chain[m] = () => chain
      }
      chain.maybeSingle = () =>
        Promise.resolve({ data: terminalData(), error: null })
      chain.single = () =>
        Promise.resolve({ data: terminalData(), error: null })
      return chain
    }
    return {
      from: (table: string) => ({
        ...chainFor(table),
        insert: (row: Record<string, unknown>) => {
          opts.inserts.push({ table, row })
          return Promise.resolve({ error: null })
        },
        update: () => {
          throw new Error(`handler must not UPDATE ${table} — executors do that on approve`)
        },
        delete: () => {
          throw new Error(`handler must not DELETE from ${table} — executors do that on approve`)
        },
      }),
    } as unknown as SupabaseClient
  }

  const ctx = { id: "call-1", callerPhone: "+16175550142" }

  afterEach(() => vi.restoreAllMocks())

  it("reschedule stages a reschedule_appointment with the matched booking", async () => {
    const inserts: Insert[] = []
    const supabase = mockSupabase({
      appointment: {
        id: "appt-1",
        scheduled_at: "2026-06-20T15:00:00Z",
        service_name: "Ceramic coating",
      },
      inserts,
    })
    const spoken = await rescheduleAppointment(
      supabase,
      "shop-1",
      { customer_name: "Sam Rivera", new_when: "Saturday at 3pm" },
      ctx
    )
    expect(inserts).toHaveLength(1)
    expect(inserts[0].table).toBe("pending_actions")
    expect(inserts[0].row.action_type).toBe("reschedule_appointment")
    const payload = inserts[0].row.payload as Record<string, unknown>
    expect(payload.appointment_id).toBe("appt-1")
    expect(payload.new_when).toBe("Saturday at 3pm")
    // Spoken reply promises a confirmation text, never a done deal.
    expect(spoken).toContain("text")
    expect(spoken.toLowerCase()).not.toContain("confirmed")
  })

  it("cancel stages a cancel_appointment and stays warm", async () => {
    const inserts: Insert[] = []
    const supabase = mockSupabase({
      appointment: {
        id: "appt-2",
        scheduled_at: "2026-06-21T10:00:00Z",
        service_name: "Interior detail",
      },
      inserts,
    })
    const spoken = await cancelAppointment(
      supabase,
      "shop-1",
      { reason: "car got totaled" },
      ctx
    )
    expect(inserts).toHaveLength(1)
    expect(inserts[0].row.action_type).toBe("cancel_appointment")
    const payload = inserts[0].row.payload as Record<string, unknown>
    expect(payload.appointment_id).toBe("appt-2")
    expect(payload.reason).toBe("car got totaled")
    expect(spoken).toContain("text")
  })

  it("no matching booking still stages — the human resolves it", async () => {
    const inserts: Insert[] = []
    const supabase = mockSupabase({ appointment: null, inserts })
    await rescheduleAppointment(
      supabase,
      "shop-1",
      { new_when: "next Tuesday" },
      ctx
    )
    expect(inserts).toHaveLength(1)
    expect((inserts[0].row.payload as Record<string, unknown>).appointment_id).toBeNull()
  })

  it("missing required info asks instead of staging garbage", async () => {
    const inserts: Insert[] = []
    const supabase = mockSupabase({ appointment: null, inserts })
    const spoken = await rescheduleAppointment(supabase, "shop-1", {}, { id: "call-2" })
    expect(inserts).toHaveLength(0)
    expect(spoken).toContain("need")
  })
})
