"use server"
import { z } from "zod"
import { defaultReportingPeriod } from "@/lib/onboarding-baseline/period"
import { requireUser, getOptionalShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import {
  readComparison,
  readStartingPoint,
  saveDraft,
  submitBaseline,
  type CommandResult,
} from "@/lib/onboarding-baseline/service"
import type { ComparisonDto, StartingPointDto } from "@/lib/onboarding-baseline/dto"
import type { TeamWorkspace } from "@/lib/team-permissions"

/**
 * Session-derived seam over the onboarding-baseline service.
 *
 * Server Functions are reachable by direct POST, so no export accepts a shop id, user id, role or
 * reporting period from the caller (`.strict()` schemas refuse extra keys). The workspace comes from
 * the session: the owner's active shop first, otherwise the one workspace where the caller is an
 * active manager holding the explicit `baseline.draft` grant. The database still re-derives
 * owner / delegated-manager authority from live membership on every call and refuses staff, revoked,
 * anonymous and cross-shop callers; this layer only decides which shop the session is *addressing*.
 *
 * Expected failures are return values, never thrown, and never an empty/zero report.
 */

type Db = Awaited<ReturnType<typeof createClient>>
type Workspace =
  | { ok: true; shopId: string; db: Db }
  | { ok: false; code: "forbidden" | "unavailable" }

const version = z.number().int().min(1).max(2147483646).nullable()
const instant = z.string().datetime({ offset: true })

async function resolveWorkspace(): Promise<Workspace> {
  await requireUser()
  const db = await createClient()
  try {
    const owned = await getOptionalShop()
    if (owned) return { ok: true, shopId: owned.id, db }
    const { data, error } = await db.rpc("team_workspaces")
    if (error || !Array.isArray(data)) return { ok: false, code: "unavailable" }
    const delegated = (data as TeamWorkspace[]).find(
      (w) => w.role === "manager" && w.capabilities.includes("baseline.draft")
    )
    return delegated ? { ok: true, shopId: delegated.id, db } : { ok: false, code: "forbidden" }
  } catch {
    return { ok: false, code: "unavailable" }
  }
}

export async function getBaselineStartingPoint(): Promise<StartingPointDto> {
  const ws = await resolveWorkspace()
  if (!ws.ok) return { status: ws.code }
  return readStartingPoint(ws.db, ws.shopId)
}

export async function getBaselineComparison(input: unknown): Promise<ComparisonDto> {
  const parsed = z
    .object({ windowStart: instant, windowEnd: instant, revision: z.number().int().min(1).optional() })
    .strict()
    .safeParse(input)
  if (!parsed.success || Date.parse(parsed.data.windowEnd) <= Date.parse(parsed.data.windowStart))
    return { status: "unavailable" }
  const ws = await resolveWorkspace()
  if (!ws.ok) return { status: ws.code }
  const c = parsed.data
  return readComparison(ws.db, ws.shopId, { start: c.windowStart, end: c.windowEnd }, c.revision)
}

export async function saveBaselineDraft(input: unknown): Promise<CommandResult<{ draftVersion: number }>> {
  const parsed = z
    .object({ answers: z.record(z.string(), z.unknown()), expectedDraftVersion: version })
    .strict()
    .safeParse(input)
  if (!parsed.success) return { ok: false, code: "invalid" }
  const ws = await resolveWorkspace()
  if (!ws.ok) return { ok: false, code: ws.code }
  return saveDraft(ws.db, { shopId: ws.shopId, ...parsed.data })
}

/**
 * Owner only (the database refuses a manager). The reporting period is "the last 90 days ending
 * yesterday (UTC)", computed here so the client can neither widen it nor describe the future.
 */
export async function submitBaselineAssessment(
  input: unknown
): Promise<CommandResult<{ revision: number; kind: "submitted" | "superseded"; supersedesRevision: number | null }>> {
  const parsed = z
    .object({
      answers: z.record(z.string(), z.unknown()),
      expectedBaseline: version,
      expectedDraftVersion: version,
    })
    .strict()
    .safeParse(input)
  if (!parsed.success) return { ok: false, code: "invalid" }
  const ws = await resolveWorkspace()
  if (!ws.ok) return { ok: false, code: ws.code }
  const period = defaultReportingPeriod(new Date())
  return submitBaseline(ws.db, {
    shopId: ws.shopId,
    answers: parsed.data.answers,
    periodStart: period.start,
    periodEnd: period.end,
    expectedBaseline: parsed.data.expectedBaseline,
    expectedDraftVersion: parsed.data.expectedDraftVersion,
  })
}
