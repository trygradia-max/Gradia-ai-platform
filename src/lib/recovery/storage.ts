/**
 * Storage I/O for Customer Recovery raw bodies (P8 / NEXT-3,
 * GRADIA_CUSTOMER_RECOVERY_SPEC §1.2). Bodies are the shop's PII — they live in
 * the PRIVATE `recovery-imports` bucket, keyed by shop/job, read only under the
 * service role, and purged after extraction (retention).
 */

import type { SupabaseClient } from "@supabase/supabase-js"

export const RECOVERY_BUCKET = "recovery-imports"

/** Object path for one staged unit's body. */
export function bodyPath(shopId: string, jobId: string, unitId: string): string {
  return `${shopId}/${jobId}/${unitId}.txt`
}

export async function storeBody(
  supabase: SupabaseClient,
  path: string,
  body: string
): Promise<boolean> {
  const { error } = await supabase.storage
    .from(RECOVERY_BUCKET)
    .upload(path, body, { contentType: "text/plain; charset=utf-8", upsert: true })
  if (error) {
    console.error("[recovery storage] upload failed:", path, error.message)
    return false
  }
  return true
}

export async function loadBody(
  supabase: SupabaseClient,
  path: string
): Promise<string | null> {
  const { data, error } = await supabase.storage.from(RECOVERY_BUCKET).download(path)
  if (error || !data) {
    console.error("[recovery storage] download failed:", path, error?.message)
    return null
  }
  return await data.text()
}

/**
 * Purge every raw body for a job (retention / post-extraction cleanup). Best
 * effort — a storage hiccup must not wedge the pipeline.
 */
export async function deleteJobBodies(
  supabase: SupabaseClient,
  shopId: string,
  jobId: string
): Promise<void> {
  const prefix = `${shopId}/${jobId}`
  const { data, error } = await supabase.storage.from(RECOVERY_BUCKET).list(prefix)
  if (error || !data) return
  const paths = data.map((f) => `${prefix}/${f.name}`)
  if (paths.length > 0) {
    await supabase.storage.from(RECOVERY_BUCKET).remove(paths)
  }
}
