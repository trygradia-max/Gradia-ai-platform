import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { claimProviderEvent } from "@/lib/provider-events"
import {
  pruneProviderEventsBatch,
  runProviderEventPruning,
} from "@/lib/provider-events-retention"
import { INTEGRATION, INTEGRATION_WITH_SESSION, anonClient, serviceClient } from "./_db"

/**
 * P0-005A — provider_events retention/pruning against REAL Postgres.
 *
 * Proves what the ticket asks for and a mock cannot: exactly the expired
 * `completed`/`failed` receipts go, `processing` rows never go by age,
 * in-window rows survive, the SQL floor clamps a too-short window, batches
 * are bounded, two genuinely concurrent runs (separate connections,
 * Promise.all) split the work without error or double count, and the
 * accepted tradeoff — a pruned ancient event id claims as new — is
 * documented by a test. Pruning is global (time/status keyed), so each
 * suite first drains any pre-existing backlog to reason about exact counts;
 * test:int runs files serially, so nothing else writes meanwhile.
 */

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`
const PREFIX = `prune-int-${STAMP}`
const eid = (label: string) => `${PREFIX}-${label}`
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

let sb: SupabaseClient
let sb2: SupabaseClient

async function seedRow(
  client: SupabaseClient,
  row: { label: string; status: "completed" | "failed" | "processing"; ageDays: number }
) {
  const ts = daysAgo(row.ageDays)
  const { error } = await client.from("provider_events").insert({
    provider: "twilio",
    event_id: eid(row.label),
    status: row.status,
    first_seen_at: ts,
    last_attempt_at: ts,
    completed_at: row.status === "completed" ? ts : null,
    failed_at: row.status === "failed" ? ts : null,
    metadata: { source: "int-test-prune" },
  })
  if (error) throw new Error(`seedRow ${row.label}: ${error.message}`)
}

async function ours(): Promise<Set<string>> {
  const { data, error } = await sb
    .from("provider_events")
    .select("event_id")
    .like("event_id", `${PREFIX}-%`)
  if (error) throw new Error(error.message)
  return new Set((data as { event_id: string }[]).map((r) => r.event_id.slice(PREFIX.length + 1)))
}

/** Clear any expired backlog left by other suites so exact counts hold. */
async function drain() {
  for (let i = 0; i < 20; i++) {
    const r = await pruneProviderEventsBatch(sb, { batchSize: 50_000 })
    if (r.completed_expired_remaining === 0 && r.failed_expired_remaining === 0) return
  }
  throw new Error("drain: expired backlog did not clear")
}

describe.skipIf(!INTEGRATION)("provider_events pruning [integration]", () => {
  beforeAll(async () => {
    sb = serviceClient()
    sb2 = serviceClient()
    await drain()
  })

  afterAll(async () => {
    if (sb) await sb.from("provider_events").delete().like("event_id", `${PREFIX}-%`)
  })

  it("prunes exactly the expired completed/failed rows — never processing, never in-window", async () => {
    await seedRow(sb, { label: "c-expired", status: "completed", ageDays: 31 })
    await seedRow(sb, { label: "c-inwindow", status: "completed", ageDays: 29 })
    await seedRow(sb, { label: "c-fresh", status: "completed", ageDays: 0 })
    await seedRow(sb, { label: "f-expired", status: "failed", ageDays: 91 })
    await seedRow(sb, { label: "f-inwindow", status: "failed", ageDays: 89 })
    await seedRow(sb, { label: "p-ancient", status: "processing", ageDays: 400 })
    await seedRow(sb, { label: "p-fresh", status: "processing", ageDays: 0 })

    const summary = await runProviderEventPruning(sb)
    expect(summary.completedPruned).toBe(1)
    expect(summary.failedPruned).toBe(1)
    expect(summary.last.completed_expired_remaining).toBe(0)
    expect(summary.last.failed_expired_remaining).toBe(0)
    expect(summary.last.processing_rows).toBeGreaterThanOrEqual(2)

    const left = await ours()
    expect(left.has("c-expired")).toBe(false)
    expect(left.has("f-expired")).toBe(false)
    expect(left.has("c-inwindow")).toBe(true)
    expect(left.has("c-fresh")).toBe(true)
    expect(left.has("f-inwindow")).toBe(true)
    expect(left.has("p-ancient")).toBe(true)
    expect(left.has("p-fresh")).toBe(true)
  })

  it("the SQL clamps a too-short window to the 7-day floor", async () => {
    await seedRow(sb, { label: "c-5d", status: "completed", ageDays: 5 })
    await seedRow(sb, { label: "f-5d", status: "failed", ageDays: 5 })
    const r = await pruneProviderEventsBatch(sb, { completedDays: 1, failedDays: 1 })
    expect(r.completed_retention_days).toBe(7)
    expect(r.failed_retention_days).toBe(7)
    const left = await ours()
    expect(left.has("c-5d")).toBe(true)
    expect(left.has("f-5d")).toBe(true)
  })

  it("batches are bounded and oldest-first; a run stops at maxBatches and the next run catches up", async () => {
    for (let i = 0; i < 5; i++) {
      await seedRow(sb, { label: `b-${i}`, status: "completed", ageDays: 200 - i })
    }
    const partial = await runProviderEventPruning(sb, { batchSize: 2, maxBatches: 2 })
    expect(partial.batches).toBe(2)
    expect(partial.completedPruned).toBe(4)
    expect(partial.last.completed_expired_remaining).toBe(1)
    const left = await ours()
    // Oldest four (b-0 … b-3, ages 200 … 197) went; the youngest expired row remains.
    expect(left.has("b-4")).toBe(true)
    expect([0, 1, 2, 3].some((i) => left.has(`b-${i}`))).toBe(false)

    const rest = await runProviderEventPruning(sb, { batchSize: 2, maxBatches: 2 })
    expect(rest.completedPruned).toBe(1)
    expect(rest.batches).toBe(1)
    expect(rest.last.completed_expired_remaining).toBe(0)
  })

  it("two concurrent runs on separate connections: no error, disjoint rows, exact total", async () => {
    const N = 40
    for (let i = 0; i < N; i++) {
      await seedRow(sb, { label: `race-${i}`, status: "completed", ageDays: 100 + i })
    }
    const [a, b] = await Promise.all([
      runProviderEventPruning(sb, { batchSize: 10, maxBatches: 2 }),
      runProviderEventPruning(sb2, { batchSize: 10, maxBatches: 2 }),
    ])
    expect(a.batches).toBe(2)
    expect(b.batches).toBe(2)
    expect(a.completedPruned + b.completedPruned).toBe(N)
    const left = await ours()
    expect([...left].filter((l) => l.startsWith("race-"))).toEqual([])
  })

  it("documented tradeoff: after pruning, a re-delivered ancient event id claims as NEW", async () => {
    await seedRow(sb, { label: "replay", status: "completed", ageDays: 400 })
    const before = await claimProviderEvent(sb, { provider: "twilio", eventId: eid("replay") })
    expect(before.outcome).toBe("duplicate_completed")

    await runProviderEventPruning(sb)
    const after = await claimProviderEvent(sb, { provider: "twilio", eventId: eid("replay") })
    // The receipt is gone, so the claim table cannot know — the retention
    // window (≥ 7d floor, 30d default) sits above every provider's retry
    // horizon, which is what makes this unreachable in practice.
    expect(after.outcome).toBe("claimed")
  })

  it.skipIf(!INTEGRATION_WITH_SESSION)("anonymous callers cannot execute the prune RPC", async () => {
    const { error } = await anonClient().rpc("prune_provider_events", { p_batch_size: 1 })
    expect(error).not.toBeNull()
    expect(error?.message ?? "").toMatch(/permission denied|not found|does not exist/i)
  })
})
