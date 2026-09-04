/**
 * B-01 — data export. Customers, vehicles, leads, appointments and
 * conversations → CSV or JSON, one entity per request. Tenant-scoped (every
 * query is filtered by shop_id) and capped (EXPORT_ROW_LIMIT) — a bounded
 * single query, not a streamed/paginated job. Revisit with pagination if a
 * shop legitimately exceeds the cap.
 *
 * `select("*")` is deliberate: an explicit column allowlist would drift out
 * of sync with the schema (see the CRM C1 job columns on `appointments`,
 * which only exist once that migration is applied — approvals.ts calls this
 * out as a "tolerance pattern"). Selecting everything and shaping the
 * output in JS means a new column shows up in the export automatically
 * instead of silently erroring or silently vanishing.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

export const EXPORT_ENTITIES = [
  "customers",
  "vehicles",
  "leads",
  "appointments",
  "conversations",
] as const

export type ExportEntity = (typeof EXPORT_ENTITIES)[number]
export type ExportFormat = "csv" | "json"

export function isExportEntity(value: string): value is ExportEntity {
  return (EXPORT_ENTITIES as readonly string[]).includes(value)
}

/** The underlying table per entity. "conversations" is the shared-brain
 *  `interactions` table (lib/memory.ts) — the owner-facing name is
 *  "conversations" everywhere else in the product (rename map). */
const TABLE_BY_ENTITY: Record<ExportEntity, string> = {
  customers: "customers",
  vehicles: "vehicles",
  leads: "leads",
  appointments: "appointments",
  conversations: "interactions",
}

/** Columns stripped from the export entirely — not useful outside the
 *  system that produced them. `embedding` is a pgvector float array
 *  (hundreds of numbers per row); it would dominate the file and means
 *  nothing to an owner reading a CSV. */
const EXCLUDED_COLUMNS: Partial<Record<ExportEntity, readonly string[]>> = {
  conversations: ["embedding", "embedding_model"],
}

/** Header row shown even when a shop has zero rows for an entity, so the
 *  file still documents its own shape. Superseded by the real columns the
 *  moment there is at least one row. */
const FALLBACK_HEADERS: Record<ExportEntity, readonly string[]> = {
  customers: [
    "id",
    "name",
    "phone",
    "email",
    "source",
    "last_visit_at",
    "last_transaction_at",
    "created_at",
    "updated_at",
  ],
  vehicles: [
    "id",
    "customer_id",
    "year",
    "make",
    "model",
    "color",
    "vin",
    "created_at",
    "updated_at",
  ],
  leads: [
    "id",
    "customer_id",
    "customer_name",
    "phone",
    "car_info",
    "status",
    "created_at",
    "updated_at",
  ],
  appointments: [
    "id",
    "lead_id",
    "customer_id",
    "scheduled_at",
    "duration_minutes",
    "service_name",
    "created_at",
    "updated_at",
  ],
  conversations: ["id", "customer_id", "channel", "role", "content", "occurred_at"],
}

/** Hard cap — see file header. Covers every alpha shop with room to spare. */
export const EXPORT_ROW_LIMIT = 10_000

export type ExportRow = Record<string, unknown>

/** Tenant-scoped fetch for one entity. Throws on a query error — the route
 *  turns that into a 500; it never returns another shop's rows. */
export async function fetchExportRows(
  supabase: SupabaseClient,
  shopId: string,
  entity: ExportEntity
): Promise<ExportRow[]> {
  const { data, error } = await supabase
    .from(TABLE_BY_ENTITY[entity])
    .select("*")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: true })
    .limit(EXPORT_ROW_LIMIT)

  if (error) {
    throw new Error(`export fetch failed (${entity}): ${error.message}`)
  }

  const exclude = new Set(EXCLUDED_COLUMNS[entity] ?? [])
  return ((data as ExportRow[] | null) ?? []).map((row) => shapeRow(row, exclude))
}

function shapeRow(row: ExportRow, exclude: Set<string>): ExportRow {
  if (exclude.size === 0) return row
  const shaped: ExportRow = {}
  for (const [key, value] of Object.entries(row)) {
    if (!exclude.has(key)) shaped[key] = value
  }
  return shaped
}

/** Column order for serialization: the real columns on the first row when
 *  there is data (so a schema change shows up automatically), else the
 *  documented fallback so an empty export still has a header. */
export function columnsFor(entity: ExportEntity, rows: ExportRow[]): string[] {
  return rows.length > 0 ? Object.keys(rows[0]) : [...FALLBACK_HEADERS[entity]]
}

/** Matches the existing CSV-escaping convention (lib/recovery/review.ts). */
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = typeof value === "string" ? value : JSON.stringify(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function rowsToCsv(rows: ExportRow[], entity: ExportEntity): string {
  const columns = columnsFor(entity, rows)
  const lines = [columns.join(",")]
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(","))
  }
  return lines.join("\n")
}

export function rowsToJson(rows: ExportRow[]): string {
  return JSON.stringify(rows, null, 2)
}

export function exportFilename(entity: ExportEntity, format: ExportFormat): string {
  const date = new Date().toISOString().slice(0, 10)
  return `gradia-${entity}-${date}.${format}`
}
