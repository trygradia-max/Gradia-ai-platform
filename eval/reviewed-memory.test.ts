import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/embeddings", () => ({
  embedText: vi.fn(async () => Array(1536).fill(0)),
  embedTexts: vi.fn(async () => []),
}))

import {
  reviewMemoryRevision,
  searchReviewedAgentMemory,
} from "@/lib/knowledge"
import type { SupabaseClient } from "@supabase/supabase-js"

function rpcClient(result: { data: unknown; error: unknown }) {
  return { rpc: vi.fn(async () => result) } as unknown as SupabaseClient
}

describe("reviewed agent memory", () => {
  it("keeps review and publication as separate explicit operations", async () => {
    const client = rpcClient({ data: true, error: null })
    await expect(
      reviewMemoryRevision(client, "shop", "source", 2)
    ).resolves.toEqual({ ok: true, outcome: "reviewed" })
    expect(client.rpc).toHaveBeenCalledWith("review_memory_revision", {
      p_shop: "shop",
      p_source: "source",
      p_revision: 2,
    })
  })

  it("binds agent retrieval to exact source revisions", async () => {
    const client = rpcClient({ data: [], error: null })
    await searchReviewedAgentMemory(
      client,
      "shop",
      [{ sourceId: "source", revision: 3 }],
      "deposit policy"
    )
    expect(client.rpc).toHaveBeenCalledWith(
      "match_reviewed_agent_memory",
      expect.objectContaining({
        p_shop_id: "shop",
        p_grants: [{ source_id: "source", revision: 3 }],
      })
    )
  })

  it("routes every general knowledge consumer through published memory", () => {
    const root = decodeURIComponent(new URL("../", import.meta.url).pathname)
    const knowledge = readFileSync(join(root, "src/lib/knowledge.ts"), "utf8")
    const migration = readFileSync(
      join(root, "supabase/migrations/20261103120000_reviewed_agent_memory.sql"),
      "utf8"
    )
    expect(knowledge).toContain('.from("published_shop_knowledge")')
    expect(knowledge).not.toContain('.from("shop_knowledge").insert')
    expect(migration).toContain("Legacy rows are deliberately not grandfathered")
    expect(migration).toContain("custom_agent_runs_reviewed_memory_revision")
  })
})
