import { z } from 'zod'

export const deliveryOutcomes = {
  delivered: 'Reported delivered',
  not_delivered: 'Reported not delivered',
  unknown: 'Still uncertain',
} as const
const outcome = z.enum(['delivered', 'not_delivered', 'unknown'])
const timestamp = z.string().datetime({ offset: true }).nullable()
const reviewerRole = z.enum(['owner', 'manager'])
export const reviewerLabels = { owner: 'shop owner', manager: 'delegated manager' } as const
export const reconciliationCommandSchema = z.object({
  shopId: z.string().uuid(),
  actionId: z.string().uuid(),
  commandId: z.string().uuid(),
  revision: z.number().int().min(0).max(2147483646),
  completedAt: timestamp,
  outcome,
  note: z.string().trim().min(10).max(2000).refine(value =>
    // Allow multiline evidence notes, but not hidden control characters.
    !Array.from(value).some(c => c.charCodeAt(0) < 32 && !'\n\r\t'.includes(c) || c.charCodeAt(0) === 127)),
}).strict()
export const reconciliationHistorySchema = z.object({
  revision: z.number().int().nonnegative(),
  completed_at: timestamp,
  viewer_role: reviewerRole,
  items: z.array(z.object({
    command_id: z.string().uuid(), revision: z.number().int().positive(),
    actor_id: z.string().uuid(), actor_label: z.string(), actor_role: reviewerRole, outcome, note: z.string(),
    created_at: z.string().datetime({ offset: true }), reviewed_completed_at: timestamp,
  })).max(21),
})
export const deliveryHoldsSchema = z.object({
  viewer_role: reviewerRole,
  items: z.array(z.object({
    action_id: z.string().uuid(), claimed_at: z.string().datetime({ offset: true }), completed_at: timestamp,
    action_type: z.string().nullable(),
    customer_id: z.string().uuid().nullable(), customer_name: z.string().nullable(), body: z.string().nullable(),
    review_revision: z.number().int().nonnegative(), latest_outcome: outcome.nullable(),
  })).max(21),
})
