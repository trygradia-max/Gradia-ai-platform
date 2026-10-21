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

// ---------- Terminal delivery conflicts (migration 20261021110000) ----------
// A message whose callbacks contradict each other (delivered vs
// undelivered/failed/canceled). Read with list_delivery_conflicts /
// read_delivery_conflict; resolve with recordDeliveryConflictResolution.
// A conflicted message's delivery_state is always 'conflicting', never
// 'delivered'. A resolution is evidence only: it never edits the message,
// resends, or changes any hold.
export const conflictResolutionStates = {
  unresolved: 'Conflicting results, not yet reviewed',
  resolved: 'Conflicting results, reviewed',
} as const
const conflictItem = z.object({
  interaction_id: z.string().uuid(),
  occurred_at: z.string().datetime({ offset: true }),
  customer_id: z.string().uuid().nullable(),
  customer_name: z.string().nullable(),
  body: z.string().nullable(),
  action_id: z.string().uuid().nullable(),
  delivery_state: z.literal('conflicting'),
  recorded_status: z.string().nullable(),
  recorded_error_code: z.string().nullable(),
  conflict_status: z.string().nullable(),
  conflict_error_code: z.string().nullable(),
  conflict_received_at: z.string().nullable(),
  review_revision: z.number().int().nonnegative(),
  latest_outcome: outcome.nullable(),
  resolution_state: z.enum(['unresolved', 'resolved']),
})
export type DeliveryConflict = z.infer<typeof conflictItem>
export const deliveryConflictsSchema = z.object({
  viewer_role: reviewerRole,
  items: z.array(conflictItem).max(21),
})
export const deliveryConflictSchema = conflictItem.extend({
  viewer_role: reviewerRole,
  history: z.array(z.object({
    command_id: z.string().uuid(), revision: z.number().int().positive(),
    actor_id: z.string().uuid(), actor_label: z.string(), actor_role: reviewerRole, outcome, note: z.string(),
    created_at: z.string().datetime({ offset: true }),
    reviewed_status: z.string(), reviewed_error_code: z.string().nullable(),
    reviewed_conflict_status: z.string(), reviewed_conflict_error_code: z.string().nullable(),
    reviewed_conflict_received_at: z.string(),
  })).max(21),
})
export const conflictResolutionCommandSchema = z.object({
  shopId: z.string().uuid(),
  interactionId: z.string().uuid(),
  commandId: z.string().uuid(),
  revision: z.number().int().min(0).max(2147483646),
  /** The conflict_received_at the reviewer saw; a newer conflict refuses the write. */
  conflictReceivedAt: z.string().min(1).max(64),
  outcome,
  note: reconciliationCommandSchema.shape.note,
}).strict()

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }
export type DeliveryConflictsRead =
  | { state: 'ok'; viewerRole: 'owner' | 'manager'; items: DeliveryConflict[] }
  | { state: 'unavailable' }
/** Read-only, page of 20 (a 21st item means there is a next page). A refused
 *  or malformed read is 'unavailable', never an empty "all clear". */
export async function readDeliveryConflicts(db: Rpc, shopId: string, page = 1): Promise<DeliveryConflictsRead> {
  try {
    const { data, error } = await db.rpc('list_delivery_conflicts', { p_shop: shopId, p_offset: (Math.max(1, Math.floor(page)) - 1) * 20 })
    if (error) return { state: 'unavailable' }
    const parsed = deliveryConflictsSchema.safeParse(data)
    return parsed.success ? { state: 'ok', viewerRole: parsed.data.viewer_role, items: parsed.data.items } : { state: 'unavailable' }
  } catch { return { state: 'unavailable' } }
}
export type DeliveryConflictRead =
  | { state: 'ok'; conflict: z.infer<typeof deliveryConflictSchema> }
  | { state: 'unavailable' }
export async function readDeliveryConflict(db: Rpc, shopId: string, interactionId: string, offset = 0): Promise<DeliveryConflictRead> {
  try {
    const { data, error } = await db.rpc('read_delivery_conflict', { p_shop: shopId, p_interaction: interactionId, p_offset: Math.max(0, Math.floor(offset)) })
    if (error) return { state: 'unavailable' }
    const parsed = deliveryConflictSchema.safeParse(data)
    return parsed.success ? { state: 'ok', conflict: parsed.data } : { state: 'unavailable' }
  } catch { return { state: 'unavailable' } }
}
