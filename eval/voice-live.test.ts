import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Security audit run-1, residual of finding #6: voice_live, vapi_assistant_id, vapi_phone_number_id,
 * voice_test_called_at and vapi_server_secret_enc are server-written (shops_protected_columns_guard).
 * Nothing here contacts Vapi, Twilio or Supabase: the "database" is an in-memory fake. The guard
 * itself is exercised against real Postgres in eval/integration/shops-voice-columns.int.test.ts and
 * scripts/verify-shops-voice-columns-migration.py.
 */

type Shop = {
  id: string; owner_id: string; voice_addon: boolean; voice_live: boolean
  vapi_assistant_id: string | null; vapi_phone_number_id: string | null; voice_test_called_at: string | null
}
const h = vi.hoisted(() => ({
  shops: [] as Record<string, unknown>[],
  writes: [] as { via: string; patch: Record<string, unknown>; filters: [string, string, unknown][] }[],
  session: { userId: "user-a", shopId: "shop-a" },
  revalidate: vi.fn(),
  failRead: false,
  failWrite: false,
}))

function fakeClient(via: string) {
  return {
    from(table: string) {
      expect(table).toBe("shops")
      const filters: [string, string, unknown][] = []
      let patch: Record<string, unknown> | null = null
      const matches = () => h.shops.filter(r => filters.every(([col, op, val]) => op === "eq" ? r[col] === val : (r[col] !== null && r[col] !== undefined)))
      const b: Record<string, unknown> = {
        select: () => b,
        update: (p: Record<string, unknown>) => { patch = p; return b },
        eq: (col: string, val: unknown) => { filters.push([col, "eq", val]); return b },
        not: (col: string) => { filters.push([col, "notnull", null]); return b },
        maybeSingle: async () => (h.failRead ? { data: null, error: { message: "boom" } } : { data: matches()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          if (!patch) return resolve({ data: matches(), error: null })
          h.writes.push({ via, patch, filters: [...filters] })
          if (h.failWrite) return resolve({ data: null, error: { message: "boom" } })
          const rows = matches()
          for (const r of rows) Object.assign(r, patch)
          return resolve({ data: rows.map(r => ({ id: r.id })), error: null })
        },
      }
      return b
    },
  }
}

vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/shop", () => ({
  requireUser: async () => ({ id: h.session.userId }),
  requireShop: async () => ({ id: h.session.shopId, name: "Shop" }),
  getOptionalShop: async () => ({ id: h.session.shopId, name: "Shop" }),
}))
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => fakeClient("service") }))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient("session") }))

import { setVoiceLive } from "@/app/actions/voice-builder"
import { setVoiceLiveForOwner } from "@/lib/voice-live"

const ready = (over: Partial<Shop> = {}): Shop => ({
  id: "shop-a", owner_id: "user-a", voice_addon: true, voice_live: false,
  vapi_assistant_id: "asst_1", vapi_phone_number_id: "pn_1", voice_test_called_at: "2026-11-01T00:00:00Z", ...over,
})
const shopA = () => h.shops.find(s => s.id === "shop-a") as Shop

describe("setVoiceLive (server action)", () => {
  beforeEach(() => {
    h.shops = [ready(), ready({ id: "shop-b", owner_id: "user-b", vapi_assistant_id: "asst_b" })]
    h.writes = []
    h.failRead = false
    h.failWrite = false
    h.session = { userId: "user-a", shopId: "shop-a" }
    h.revalidate.mockClear()
  })

  it("never writes voice_live through the owner's session client", async () => {
    expect(await setVoiceLive(true)).toEqual({ ok: true })
    expect(await setVoiceLive(false)).toEqual({ ok: true })
    expect(h.writes.length).toBeGreaterThan(0)
    expect(h.writes.every(w => w.via === "service")).toBe(true)
    expect(h.revalidate).toHaveBeenCalledWith("/settings")
  })

  it("takes only the target state from the caller; the shop and user come from the session", async () => {
    // A hostile caller passing extra arguments cannot name another shop or user.
    await (setVoiceLive as unknown as (...a: unknown[]) => Promise<unknown>)(true, "shop-b", "user-b")
    expect(shopA().voice_live).toBe(true)
    expect(h.shops.find(s => s.id === "shop-b")!.voice_live).toBe(false)
    expect(h.writes.every(w => w.filters.some(f => f[0] === "id" && f[2] === "shop-a") && w.filters.some(f => f[0] === "owner_id" && f[2] === "user-a"))).toBe(true)
  })

  it("coerces a non-boolean 'live' to a pause, never to going live", async () => {
    shopA().voice_live = true
    await (setVoiceLive as unknown as (v: unknown) => Promise<unknown>)("true")
    expect(shopA().voice_live).toBe(false)
  })
})

describe("setVoiceLiveForOwner", () => {
  beforeEach(() => {
    h.shops = [ready(), ready({ id: "shop-b", owner_id: "user-b" })]
    h.writes = []
    h.failRead = false
    h.failWrite = false
  })
  const go = (live: boolean, userId = "user-a", shopId = "shop-a") =>
    setVoiceLiveForOwner({ service: fakeClient("service") as never, userId, shopId, live })

  it("goes live only with the add-on and a complete launch gate; nothing is written otherwise", async () => {
    for (const patch of [
      { voice_addon: false }, { vapi_assistant_id: null }, { vapi_phone_number_id: null }, { voice_test_called_at: null },
    ] as Partial<Shop>[]) {
      h.shops = [ready(patch)]
      h.writes = []
      expect(await go(true)).toMatchObject({ ok: false })
      expect(h.writes).toEqual([])
      expect(shopA().voice_live).toBe(false)
    }
    h.shops = [ready()]
    expect(await go(true)).toEqual({ ok: true })
    expect(shopA().voice_live).toBe(true)
  })

  it("names the missing gate steps, in order", async () => {
    h.shops = [ready({ vapi_assistant_id: null, vapi_phone_number_id: null, voice_test_called_at: null })]
    const res = await go(true)
    expect(res).toEqual({ ok: false, error: "Almost there — first connect your business number, then save the receptionist, then do a test call." })
  })

  it("the launch gate is repeated inside the UPDATE's own filters", async () => {
    await go(true)
    const w = h.writes[0]
    const cols = w.filters.map(f => f[0]).sort()
    expect(cols).toEqual(["id", "owner_id", "vapi_assistant_id", "vapi_phone_number_id", "voice_addon", "voice_test_called_at"])
    expect(w.patch).toEqual({ voice_live: true })
  })

  it("an owner id that does not own the shop reads nothing, writes nothing", async () => {
    expect(await go(true, "user-a", "shop-b")).toEqual({ ok: false, error: "Finish onboarding first." })
    expect(await go(false, "user-a", "shop-b")).toEqual({ ok: false, error: "Finish onboarding first." })
    expect(h.writes).toEqual([])
    expect(h.shops.find(s => s.id === "shop-b")!.voice_live).toBe(false)
  })

  it("pausing needs only ownership", async () => {
    h.shops = [ready({ voice_live: true, voice_addon: false, vapi_assistant_id: null })]
    expect(await go(false)).toEqual({ ok: true })
    expect(shopA().voice_live).toBe(false)
  })

  it("a read or write failure is reported without leaking provider or database detail", async () => {
    h.failRead = true
    expect(await go(true)).toEqual({ ok: false, error: "Couldn't update the receptionist — try again." })
    h.failRead = false
    h.failWrite = true
    expect(await go(true)).toEqual({ ok: false, error: "Couldn't update the receptionist — try again." })
    expect(shopA().voice_live).toBe(false)
  })

  it("a write that matches no row (gate lost between read and write) does not report success", async () => {
    // Simulate the add-on ending after the read: the conditional UPDATE matches nothing.
    const real = fakeClient("service")
    let reads = 0
    const racing = {
      from: (t: string) => {
        const b = real.from(t) as Record<string, unknown>
        const origMaybe = b.maybeSingle as () => Promise<unknown>
        b.maybeSingle = async () => { const out = await origMaybe(); reads++; shopA().voice_addon = false; return out }
        return b
      },
    }
    const res = await setVoiceLiveForOwner({ service: racing as never, userId: "user-a", shopId: "shop-a", live: true })
    expect(reads).toBe(1)
    expect(res).toMatchObject({ ok: false })
    expect(shopA().voice_live).toBe(false)
  })
})

describe("structural locks: no owner-session writer of the server-written voice columns", () => {
  const VOICE = /\b(vapi_assistant_id|vapi_phone_number_id|voice_live|voice_test_called_at|vapi_server_secret_enc)\b/
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(name)) files.push(p)
    }
  }
  walk("src")
  const read = (f: string) => readFileSync(f, "utf8")
  /** `.update({ ... })` argument object text for every update call in a file. */
  const updates = (src: string) => [
    ...[...src.matchAll(/\.update\(\s*(\{[^}]*\})/g)].map(m => m[1]),
    // patch objects built up as `update.voice_live = false` (the Stripe webhook) and then passed to .update(update)
    ...[...src.matchAll(/\bupdate\.(\w+)\s*=/g)].map(m => m[1]),
  ]

  it("the unused owner-session saveVapiAssistantId is gone", () => {
    expect(files.filter(f => read(f).includes("saveVapiAssistantId"))).toEqual([])
  })

  it("only the reviewed trusted writers update these columns", () => {
    const writers = files.filter(f => updates(read(f)).some(u => VOICE.test(u))).map(f => f.replace(/\\/g, "/")).sort()
    expect(writers).toEqual([
      "src/app/api/stripe/webhook/route.ts",
      "src/lib/voice-live.ts",
      "src/lib/voice-provider.ts",
    ])
  })

  it("setVoiceLive writes through the service seam, not through its own shops update", () => {
    const src = read("src/app/actions/voice-builder.ts")
    const body = src.slice(src.indexOf("export async function setVoiceLive"), src.indexOf("const budgetSchema"))
    expect(body).toContain("setVoiceLiveForOwner")
    expect(body).toContain("createServiceClient()")
    expect(body).not.toContain('.from("shops")')
    expect(body).not.toContain("createClient()")
  })

  it("every caller of the provider writers hands them the service client", () => {
    const actions = read("src/app/actions/voice-builder.ts")
    expect(actions).toMatch(/syncVoiceAssistant\(\{\s*supabase,/) // saveVoiceConfig: `const supabase = createServiceClient()`
    expect(actions).toMatch(/const supabase = createServiceClient\(\)[\s\S]*syncVoiceAssistant/)
    expect(actions).toMatch(/attachVoiceNumber\(\{\s*supabase: createServiceClient\(\)/)
    const cron = read("src/app/api/cron/voice-sync/route.ts")
    expect(cron).toMatch(/const supabase = createServiceClient\(\)/)
    expect(cron).toMatch(/syncVoiceAssistant\(\{ supabase, shop, origin \}\)/)
    expect(read("src/lib/voice-test-call.ts")).toMatch(/startVoiceTestCall\(\{\s*supabase: deps\.service/)
  })

  it("the stripe webhook writes these columns with the service client", () => {
    const src = read("src/app/api/stripe/webhook/route.ts")
    expect(src).toContain("createServiceClient")
    expect(src).not.toMatch(/from "@\/lib\/supabase\/server"/)
  })

  it("the database guard names every one of the five columns on both INSERT and UPDATE", () => {
    const sql = read("supabase/migrations/20261115120000_shops_voice_columns_guard.sql")
    const insertBranch = sql.slice(sql.indexOf("IF TG_OP='INSERT'"), sql.indexOf("ELSE\n  v_col"))
    const updateBranch = sql.slice(sql.indexOf("ELSE\n  v_col"), sql.indexOf("IF v_col IS NOT NULL"))
    for (const col of ["vapi_assistant_id", "vapi_phone_number_id", "voice_live", "voice_test_called_at", "vapi_server_secret_enc"]) {
      expect(insertBranch).toContain(`THEN '${col}'`)
      expect(updateBranch).toContain(`THEN '${col}'`)
    }
  })
})
