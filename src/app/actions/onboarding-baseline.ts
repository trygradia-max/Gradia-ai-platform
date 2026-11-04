"use server"
import { z } from "zod"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import {
  readComparison,
  readStartingPoint,
  saveDraft,
  submitBaseline,
} from "@/lib/onboarding-baseline/service"

// Server actions are public endpoints: the shop id is only an address. The
// database derives owner / delegated-manager authority from the signed-in
// session on every call and refuses staff, revoked, anonymous and cross-shop callers.
const id = z.string().uuid()
const version = z.number().int().min(1).max(2147483646).nullable()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const instant = z.string().datetime({ offset: true })

export async function getBaselineStartingPoint(shopId: unknown) {
  const parsed = id.safeParse(shopId)
  if (!parsed.success) return { status: "unavailable" } as const
  await requireUser()
  return readStartingPoint(await createClient(), parsed.data)
}

export async function getBaselineComparison(input: unknown) {
  const parsed = z.object({
    shopId: id, windowStart: instant, windowEnd: instant, revision: z.number().int().min(1).optional(),
  }).strict().safeParse(input)
  if (!parsed.success || Date.parse(parsed.data.windowEnd) <= Date.parse(parsed.data.windowStart))
    return { status: "unavailable" } as const
  await requireUser()
  const c = parsed.data
  return readComparison(await createClient(), c.shopId, { start: c.windowStart, end: c.windowEnd }, c.revision)
}

export async function saveBaselineDraft(input: unknown) {
  const parsed = z.object({ shopId: id, answers: z.record(z.string(), z.unknown()), expectedDraftVersion: version }).strict().safeParse(input)
  if (!parsed.success) return { ok: false, code: "invalid" } as const
  await requireUser()
  return saveDraft(await createClient(), parsed.data)
}

export async function submitBaselineAssessment(input: unknown) {
  const parsed = z.object({
    shopId: id, answers: z.record(z.string(), z.unknown()), periodStart: date, periodEnd: date,
    expectedBaseline: version, expectedDraftVersion: version, evidence: z.array(id).max(50).optional(),
  }).strict().safeParse(input)
  if (!parsed.success) return { ok: false, code: "invalid" } as const
  await requireUser()
  return submitBaseline(await createClient(), parsed.data)
}
