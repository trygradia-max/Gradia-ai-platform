import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_note"), payload: z.object({
    content: z.string().trim().min(1).max(8000),
    customer_name: z.string().max(200).nullable(), phone: z.string().max(60).nullable(),
  }).strict() }),
  z.object({ type: z.literal("create_lead"), payload: z.object({
    customer_name: z.string().trim().min(1).max(200), phone: z.string().max(60),
    car_info: z.string().max(200).nullable(), pin_notes: z.string().max(2000).nullable(),
    status: z.enum(["new", "quoted", "booked"]),
  }).strict() }),
])
export type CaptureCommand = z.infer<typeof commandSchema>

/** Stable per tool invocation, scoped to the authenticated shop and source. */
export function captureCommandId(shopId: string, source: string, invocationId: string): string {
  const hash = createHash("sha256").update(JSON.stringify([shopId, source, invocationId])).digest("hex")
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`
}

/** No domain writes, embeddings or transport here. Execution stays in approvals. */
export async function stageAgentCapture(
  db: SupabaseClient,
  context: { shopId: string; actorId: string; commandId: string; source: "owner_agent" | "mcp"; tokenId?: string },
  command: CaptureCommand,
): Promise<{ ok: true; pending_action_id: string; message: string } | { ok: false; error: string }> {
  const parsed = commandSchema.safeParse(command)
  const ids = z.array(z.string().uuid()).safeParse([context.shopId, context.actorId, context.commandId, ...(context.tokenId ? [context.tokenId] : [])])
  if (!parsed.success || !ids.success || (context.source === "mcp" && !context.tokenId)) {
    return { ok: false, error: "Invalid capture request. Nothing was saved or queued." }
  }
  try {
    const { data, error } = await db.rpc("stage_agent_capture", {
      p_shop: context.shopId, p_actor: context.actorId, p_command: context.commandId,
      p_type: parsed.data.type, p_payload: parsed.data.payload,
      p_source: context.source, p_token: context.tokenId ?? null,
    })
    if (error || data !== context.commandId) return { ok: false, error: "Capture could not be queued. Check current policy and access, then review Approvals before retrying." }
    return { ok: true, pending_action_id: data, message: "Capture queued in Approvals, or already queued by this request. Check its current status there; this tool did not save CRM data." }
  } catch {
    return { ok: false, error: "Capture status could not be verified. Check Approvals before retrying." }
  }
}
