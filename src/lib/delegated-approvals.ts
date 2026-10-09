import { z } from "zod"

const reviewHash = z.string().regex(/^[0-9a-f]{64}$/)
export const delegatedApprovalCommandSchema = z
  .object({ shopId: z.string().uuid(), actionId: z.string().uuid(), reviewHash })
  .strict()
export const delegatedApprovalsSchema = z.object({
  viewer_role: z.enum(["owner", "manager"]),
  items: z
    .array(
      z.object({
        action_id: z.string().uuid(),
        action_type: z.enum(["send_sms", "send_email"]),
        created_at: z.string().datetime({ offset: true }),
        customer_id: z.string().uuid().nullable(),
        customer_name: z.string().nullable(),
        destination: z.string().nullable(),
        subject: z.string().nullable(),
        body: z.string().nullable(),
        purpose: z.enum(["service", "marketing"]),
        reason: z.string().nullable(),
        review_hash: reviewHash,
      })
    )
    .max(21),
})
export type DelegatedApproval = z.infer<typeof delegatedApprovalsSchema>["items"][number]
