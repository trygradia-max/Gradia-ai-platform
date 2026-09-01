/**
 * Runtime-shape validator for AgentConfig (P0-011, audit M-2).
 *
 * `saveCustomAgent` / `previewCustomAgentPlan` accept a config object from
 * the CLIENT — the planner validated what IT emitted, but nothing stopped a
 * hand-crafted payload from carrying arbitrary filter keys or out-of-range
 * values into `custom_agents.config` and from there into the audience
 * resolver. This schema mirrors what the RUNTIME actually accepts
 * (`agent-audience.ts` whitelisted filters, `agent-runtime.ts` recipes) and
 * is enforced at the two write/preview boundaries.
 *
 * Deliberately separate from the planner's tool schema (`agent-planner.ts`):
 * that schema is part of the model prompt (eval-gated — never edited for
 * validation needs); this one is the server-side gate. READS of saved rows
 * stay tolerant — existing agents are never bricked by validation drift.
 */

import { z } from "zod"

import type { AgentConfig } from "@/lib/types/database"

/** Whitelisted freeform audience filters — `.strict()` so an unknown key is
 *  a hard rejection, not a silently-ignored passenger. Bounds match the
 *  planner's and the resolver's assumptions. */
const freeformFiltersSchema = z
  .object({
    lead_status: z.enum(["new", "quoted", "booked"]).optional(),
    min_age_days: z.number().int().min(0).max(3650).optional(),
    max_age_days: z.number().int().min(0).max(3650).optional(),
    no_inbound_within_days: z.number().int().min(1).max(365).optional(),
    inactive_days: z.number().int().min(1).max(3650).optional(),
    keyword: z.string().min(2).max(60).optional(),
    vehicle_make: z.string().min(2).max(40).optional(),
    vehicle_model: z.string().min(1).max(60).optional(),
    vehicle_year_min: z.number().int().min(1900).max(2100).optional(),
    vehicle_year_max: z.number().int().min(1900).max(2100).optional(),
    not_visited_in_days: z.number().int().min(1).max(3650).optional(),
    recovered_only: z.boolean().optional(),
  })
  .strict()

const freeformPlanSchema = z
  .object({
    entity: z.enum(["leads", "customers"]),
    channel: z.enum(["sms", "email"]),
    filters: freeformFiltersSchema,
    message_intent: z.string().min(8).max(400),
    max_recipients: z.number().int().min(1).max(200),
    cooldown_days: z.number().int().min(1).max(365),
  })
  .strict()

const recipeSchema = z.discriminatedUnion("id", [
  z
    .object({
      id: z.literal("lead_followup_sms"),
      params: z
        .object({
          status: z.enum(["new", "quoted", "booked"]),
          min_lead_age_days: z.number().int().min(1).max(180),
          no_inbound_within_days: z.number().int().min(1).max(180),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal("appointment_reminder_email"),
      params: z
        .object({
          hours_before: z.number().int().min(1).max(168),
          window_hours: z.number().int().min(1).max(24),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal("appointment_reminder_sms"),
      params: z
        .object({
          hours_before: z.number().int().min(1).max(168),
          window_hours: z.number().int().min(1).max(24),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal("stale_customer_sms"),
      params: z
        .object({
          inactive_days: z.number().int().min(7).max(365),
          cooldown_days: z.number().int().min(7).max(365),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal("payment_received_thank_you_sms"),
      params: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal("booking_approved_prep_email"),
      params: z.object({}).strict(),
    })
    .strict(),
  z
    .object({ id: z.literal("review_request_sms"), params: z.object({}).strict() })
    .strict(),
  z
    .object({ id: z.literal("review_request_email"), params: z.object({}).strict() })
    .strict(),
])

const scheduleSchema = z
  .object({
    cadence: z.enum(["hourly", "daily", "weekly"]),
    hour_of_day: z.number().int().min(0).max(23).optional(),
    day_of_week: z.number().int().min(0).max(6).optional(),
  })
  .strict()

export const agentConfigSchema = z
  .object({
    name: z.string().min(3).max(80),
    short_description: z.string().min(8).max(240),
    trigger: z
      .object({
        kind: z.enum(["schedule", "event"]),
        schedule_summary: z.string().max(200).optional(),
        event_summary: z.string().max(200).optional(),
      })
      .strict(),
    audience: z
      .object({
        entity: z.enum(["leads", "customers", "appointments", "interactions"]),
        filters_summary: z.array(z.string().min(2).max(200)).min(1).max(6),
      })
      .strict(),
    action: z
      .object({
        kind: z.enum(["draft_sms", "draft_email", "log_note", "flag_for_review"]),
        intent_summary: z.string().min(8).max(400),
      })
      .strict(),
    prerequisites_needed: z.array(z.string().min(2).max(120)).max(8),
    human_in_the_loop_note: z.string().min(8).max(300),
    recipe: recipeSchema.optional(),
    freeform: freeformPlanSchema.optional(),
    schedule: scheduleSchema.optional(),
  })
  .strict()

export type ParsedAgentConfig = z.infer<typeof agentConfigSchema>

/** Parse an untrusted config payload into the runtime shape. */
export function parseAgentConfig(
  input: unknown
): { ok: true; config: AgentConfig } | { ok: false; error: string } {
  const parsed = agentConfigSchema.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const path = first?.path.join(".") || "config"
    return {
      ok: false,
      error: `The plan didn't validate (${path}: ${first?.message ?? "invalid"}).`,
    }
  }
  return { ok: true, config: parsed.data as AgentConfig }
}
