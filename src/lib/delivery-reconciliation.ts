import { z } from 'zod'

export const deliveryOutcomes = {
  delivered: 'Owner reports delivered',
  not_delivered: 'Owner reports not delivered',
  unknown: 'Still uncertain',
} as const
const outcome = z.enum(['delivered', 'not_delivered', 'unknown'])
const timestamp = z.string().datetime({ offset: true }).nullable()
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
  items: z.array(z.object({
    command_id: z.string().uuid(), revision: z.number().int().positive(),
    actor_id: z.string().uuid(), actor_label: z.string(), outcome, note: z.string(),
    created_at: z.string().datetime({ offset: true }), reviewed_completed_at: timestamp,
  })).max(21),
})
