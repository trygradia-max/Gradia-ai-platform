import { afterEach, describe, expect, it, vi } from "vitest"

import * as exportData from "@/lib/export-data"
import * as rateLimit from "@/lib/rate-limit"
import * as shopLib from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

/**
 * B-01 — GET /api/export. Locks the gate order (auth → shop → rate limit →
 * entity validation → tenant-scoped fetch) and that the shop id is always
 * SERVER-derived from the session (getOptionalShop), never taken from the
 * query string — a caller cannot name a different tenant.
 */

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}))
vi.mock("@/lib/shop", () => ({
  getOptionalShop: vi.fn(),
}))
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const original = await importOriginal<typeof rateLimit>()
  return {
    ...original,
    checkRateLimit: vi.fn(async () => ({
      allowed: true,
      remaining: 9,
      resetInSeconds: 3_600,
    })),
  }
})
vi.mock("@/lib/export-data", async (importOriginal) => {
  const original = await importOriginal<typeof exportData>()
  return {
    ...original,
    fetchExportRows: vi.fn(async () => [{ id: "1", shop_id: "shop-1" }]),
  }
})

const mockedCreateClient = vi.mocked(createClient)
const mockedGetOptionalShop = vi.mocked(shopLib.getOptionalShop)
const mockedRateLimit = vi.mocked(rateLimit.checkRateLimit)
const mockedFetchRows = vi.mocked(exportData.fetchExportRows)

function authedClient(userId: string | null) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
      })),
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>
}

function arrangeHappyPath() {
  mockedCreateClient.mockResolvedValue(authedClient("owner-1"))
  mockedGetOptionalShop.mockResolvedValue({ id: "shop-1", name: "Shine Co" })
  mockedRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetInSeconds: 3_600 })
}

function req(qs: string) {
  return new Request(`http://localhost/api/export${qs}`)
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/export — auth + tenant gate", () => {
  it("refuses an unauthenticated caller before touching the database", async () => {
    mockedCreateClient.mockResolvedValue(authedClient(null))
    const { GET } = await import("@/app/api/export/route")

    const res = await GET(req("?entity=customers"))

    expect(res.status).toBe(401)
    expect(mockedFetchRows).not.toHaveBeenCalled()
  })

  it("refuses an authenticated user with no shop", async () => {
    mockedCreateClient.mockResolvedValue(authedClient("owner-1"))
    mockedGetOptionalShop.mockResolvedValue(null)
    const { GET } = await import("@/app/api/export/route")

    const res = await GET(req("?entity=customers"))

    expect(res.status).toBe(403)
    expect(mockedFetchRows).not.toHaveBeenCalled()
  })

  it("binds the data_export rate limit before fetching", async () => {
    arrangeHappyPath()
    mockedRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetInSeconds: 120 })
    const { GET } = await import("@/app/api/export/route")

    const res = await GET(req("?entity=customers"))

    expect(res.status).toBe(429)
    expect(mockedRateLimit).toHaveBeenCalledWith("shop-1", "data_export")
    expect(mockedFetchRows).not.toHaveBeenCalled()
  })

  it("rejects an unknown entity without querying the database", async () => {
    arrangeHappyPath()
    const { GET } = await import("@/app/api/export/route")

    const res = await GET(req("?entity=shops"))

    expect(res.status).toBe(400)
    expect(mockedFetchRows).not.toHaveBeenCalled()
  })

  it("fetches using the session-derived shop id, never one from the query string", async () => {
    arrangeHappyPath()
    const { GET } = await import("@/app/api/export/route")

    await GET(req("?entity=customers&shop_id=someone-elses-shop"))

    expect(mockedFetchRows).toHaveBeenCalledWith(expect.anything(), "shop-1", "customers")
  })
})

describe("GET /api/export — response shape", () => {
  it("defaults to CSV with the right content type and a download filename", async () => {
    arrangeHappyPath()
    const { GET } = await import("@/app/api/export/route")

    const res = await GET(req("?entity=customers"))
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/csv")
    expect(res.headers.get("content-disposition")).toContain("gradia-customers-")
    expect(body).toContain("id,shop_id")
    expect(body).toContain("1,shop-1")
  })

  it("returns JSON when format=json is requested", async () => {
    arrangeHappyPath()
    const { GET } = await import("@/app/api/export/route")

    const res = await GET(req("?entity=leads&format=json"))
    const body = await res.text()

    expect(res.headers.get("content-type")).toContain("application/json")
    expect(res.headers.get("content-disposition")).toContain(".json")
    expect(JSON.parse(body)).toEqual([{ id: "1", shop_id: "shop-1" }])
  })

  it("returns a 500 without leaking internals when the fetch throws", async () => {
    arrangeHappyPath()
    mockedFetchRows.mockRejectedValue(new Error("db exploded with a connection string in it"))
    const { GET } = await import("@/app/api/export/route")

    const res = await GET(req("?entity=customers"))
    const body = await res.text()

    expect(res.status).toBe(500)
    expect(body).not.toContain("connection string")
  })
})
