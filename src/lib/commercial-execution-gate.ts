import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

/**
 * Lapse gate for NEW paid execution (Commercial Billing PR E1).
 *
 * The database decides (`commercial_execution_gate`): a workspace with no commercial
 * billing account is legacy and unchanged; a workspace WITH an account may start new paid
 * work only while its reviewed subscription evidence is active and its verified period
 * has not elapsed. Anything else — past due, canceled, incomplete, checkout not finished,
 * reconciliation required, period elapsed, or a read that fails or is unreadable — blocks.
 *
 * Blocking only stops NEW work. It never deletes or edits an agent definition, evidence,
 * approval or audit row, and it never disables an agent or revokes anyone's access: the
 * owner can still open the app, fix payment, and see everything. Grace length and
 * automatic dunning timing are founder-policy-required, so there is no grace: past_due
 * blocks immediately.
 */

export type ExecutionGate =
  | { allowed: true; mode: "legacy_no_commercial_account" | "commercial" }
  | { allowed: false; reason: string; state: string | null }

const gateSchema = z.object({
  allowed: z.boolean(),
  mode: z.enum(["legacy_no_commercial_account", "commercial"]),
  state: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
})

/** Interprets the database answer. Unreadable or inconsistent is a block, never an allow. */
export function interpretExecutionGate(data: unknown): ExecutionGate {
  const parsed = gateSchema.safeParse(data)
  if (!parsed.success) return { allowed: false, reason: "billing_state_unavailable", state: null }
  const g = parsed.data
  if (g.allowed) {
    // An allow must be unambiguous: no reason attached and a recognised mode.
    return g.reason ? { allowed: false, reason: "billing_state_unavailable", state: g.state ?? null } : { allowed: true, mode: g.mode }
  }
  return { allowed: false, reason: g.reason || "billing_state_unavailable", state: g.state ?? null }
}

export async function assessCommercialExecution(service: SupabaseClient, shopId: string): Promise<ExecutionGate> {
  try {
    const { data, error } = await service.rpc("commercial_execution_gate", { p_shop: shopId })
    if (error) return { allowed: false, reason: "billing_state_unavailable", state: null }
    return interpretExecutionGate(data)
  } catch {
    return { allowed: false, reason: "billing_state_unavailable", state: null }
  }
}

export function billingBlockedReason(gate: Extract<ExecutionGate, { allowed: false }>): string {
  return `billing is not active (${gate.reason}) — nothing was run; your agent and its history are unchanged`
}
