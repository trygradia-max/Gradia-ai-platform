import { z } from "zod";
const id = z.string().uuid();
export const channelSchema = z.enum(["sms", "email", "voice"]);
export const statusSchema = z.enum(["needs_reply", "awaiting_approval", "held", "completed"]);
export const threadListSchema = z.object({ unidentified: z.number(), notifications: z.number(), items: z.array(z.object({
        id, customer_id: id, customer_name: z.string().nullable(), channel: channelSchema, preview: z.string(), created_at: z.string(), unread: z.boolean(), notified: z.boolean(), state: statusSchema, assignee: z.string(),
    })) });
export const threadSchema = z.object({
    latest_id: id, revision: z.number().int(), state: statusSchema, reason: z.string(), assignee_id: id.nullable(), can_manage: z.boolean(), can_reply: z.boolean(), customer_id: id, channel: channelSchema,
    customer: z.object({ name: z.string().nullable(), phone: z.string().nullable(), email: z.string().nullable() }),
    items: z.array(z.object({ id, role: z.enum(["customer", "gradia", "system"]), content: z.string(), created_at: z.string(), occurred_at: z.string() })),
    members: z.array(z.object({ id, name: z.string() })), intakes: z.array(z.object({ id, vehicle_id: id.nullable() })), actions: z.array(z.object({ id, status: z.string(), result_id: id.nullable() })),
});
export type WhisperThread = z.infer<typeof threadSchema>;
export type InboxThreadItem = z.infer<typeof threadListSchema>["items"][number];
const envelope = { shopId: id, customerId: id, channel: channelSchema, commandId: id, latestId: id, revision: z.number().int().nonnegative() };
export const whisperCommandSchema = z.discriminatedUnion("operation", [
    z.object({ ...envelope, operation: z.literal("read"), payload: z.object({}).strict() }).strict(),
    z.object({ ...envelope, operation: z.literal("handoff"), payload: z.object({ state: z.enum(["needs_reply", "held", "completed"]), reason: z.string().max(1000), assignee_id: id.nullable() }).strict() }).strict(),
    z.object({ ...envelope, operation: z.literal("reply"), payload: z.object({ body: z.string().trim().min(1).max(8000), subject: z.string().max(200), destination: z.string().min(1).max(254) }).strict() }).strict(),
]);
export const threadStateLabels = { needs_reply: "Needs reply", awaiting_approval: "Awaiting approval", held: "Held — review required", completed: "Completed by operator" };
