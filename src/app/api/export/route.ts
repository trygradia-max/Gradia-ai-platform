/**
 * B-01 — data export. GET /api/export?entity=customers&format=csv
 *
 * Auth → tenant scoping → rate limit → tenant-scoped fetch → file download.
 * Read-only, no HITL surface — this ticket carries no money or calendar
 * writes, so the autonomy floor (guardrail #1/#2) does not apply here.
 *
 * A plain GET keeps this a normal browser download (session cookie carries
 * auth, Content-Disposition names the file) — no client-side fetch/blob
 * plumbing, no separate API key.
 */

import { EXPORT_ENTITIES, exportFilename, fetchExportRows, isExportEntity, rowsToCsv, rowsToJson, type ExportFormat } from "@/lib/export-data"
import { checkRateLimit } from "@/lib/rate-limit"
import { getOptionalShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } })
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return textResponse("Sign-in expired — refresh.", 401)

  const shop = await getOptionalShop()
  if (!shop) return textResponse("Set up your shop first.", 403)

  const limit = await checkRateLimit(shop.id, "data_export")
  if (!limit.allowed) {
    return textResponse(`Too many exports — try again in ${limit.resetInSeconds}s.`, 429)
  }

  const url = new URL(request.url)
  const entityParam = url.searchParams.get("entity") ?? ""
  if (!isExportEntity(entityParam)) {
    return textResponse(`entity must be one of: ${EXPORT_ENTITIES.join(", ")}`, 400)
  }
  const format: ExportFormat = url.searchParams.get("format") === "json" ? "json" : "csv"

  let rows: Awaited<ReturnType<typeof fetchExportRows>>
  try {
    // shop.id is server-derived from the session (getOptionalShop) — the
    // request cannot name a different tenant (guardrail #5).
    rows = await fetchExportRows(supabase, shop.id, entityParam)
  } catch (err) {
    console.error("[export] fetch failed:", err)
    return textResponse("Export failed — try again.", 500)
  }

  const body = format === "json" ? rowsToJson(rows) : rowsToCsv(rows, entityParam)
  const contentType = format === "json" ? "application/json" : "text/csv"

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": `${contentType}; charset=utf-8`,
      "content-disposition": `attachment; filename="${exportFilename(entityParam, format)}"`,
      "cache-control": "no-store",
    },
  })
}
