import { describe, it, expect, afterAll } from "vitest"

import { stampCronHeartbeat } from "@/lib/cron-run"
import { INTEGRATION, INTEGRATION_WITH_SESSION, anonClient, serviceClient } from "./_db"

/**
 * P0-012 — cron_heartbeats against REAL Postgres: the stamp upsert lands,
 * failure/success alternate correctly, the error is bounded, and the table
 * is invisible to anonymous callers (deny-all RLS).
 */

const NAME = `int-heartbeat-${Date.now()}`

describe.skipIf(!INTEGRATION)("cron_heartbeats [integration]", () => {
  afterAll(async () => {
    if (INTEGRATION) await serviceClient().from("cron_heartbeats").delete().eq("name", NAME)
  })

  it("success then failure then success: one row, stamps move, error bounded and cleared", async () => {
    const sb = serviceClient()
    await stampCronHeartbeat(NAME, { ok: true }, sb as never)
    let { data } = await sb.from("cron_heartbeats").select("*").eq("name", NAME).single()
    expect(data?.last_success_at).toBeTruthy()
    expect(data?.last_failure_at).toBeNull()

    await stampCronHeartbeat(NAME, { ok: false, error: "e".repeat(5_000) }, sb as never)
    ;({ data } = await sb.from("cron_heartbeats").select("*").eq("name", NAME).single())
    expect(data?.last_failure_at).toBeTruthy()
    expect(String(data?.last_error)).toHaveLength(200)
    const firstSuccess = data?.last_success_at

    await stampCronHeartbeat(NAME, { ok: true }, sb as never)
    ;({ data } = await sb.from("cron_heartbeats").select("*").eq("name", NAME).single())
    expect(data?.last_error).toBeNull()
    expect(Date.parse(data?.last_success_at)).toBeGreaterThan(Date.parse(firstSuccess))
    expect(Date.parse(data?.last_success_at)).toBeGreaterThan(Date.parse(data?.last_failure_at))

    const { count } = await sb.from("cron_heartbeats").select("*", { count: "exact", head: true }).eq("name", NAME)
    expect(count).toBe(1)
  })

  it.skipIf(!INTEGRATION_WITH_SESSION)("anonymous callers see no heartbeat rows", async () => {
    const { data, error } = await anonClient().from("cron_heartbeats").select("name").eq("name", NAME)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })
})
