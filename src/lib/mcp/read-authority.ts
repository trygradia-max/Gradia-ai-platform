import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"
import { hasMcpCapability } from "./capabilities"
import { policyDraftSchema } from "@/lib/control-center/drafts"
import { ACTIONS, type Connector } from "@/lib/control-center/policy"

type ReadOperation = "crm.read" | "history.read" | "menu.read" | "availability.read"
type ReadRequirement = { operation: ReadOperation; connector?: Connector }
export const MCP_READ_REQUIREMENTS: Record<string, readonly ReadRequirement[]> = {
  find_customer_by_channel: [{ operation: "crm.read" }],
  search_customer_memory: [{ operation: "history.read", connector: "memory" }],
  search_shop_knowledge: [{ operation: "history.read", connector: "memory" }],
  recent_channel_activity: [{ operation: "history.read" }],
  list_services: [{ operation: "menu.read" }],
  shop_snapshot: [{ operation: "crm.read" }, { operation: "availability.read" }],
  recent_customers: [{ operation: "crm.read" }],
  active_leads: [{ operation: "crm.read" }],
  customer_detail: [{ operation: "crm.read" }],
  customer_timeline: [{ operation: "history.read" }],
}
const contextSchema = z.object({ shopId: z.string().uuid(), ownerId: z.string().uuid(), tokenId: z.string().uuid() })
export const MCP_READ_DENIED = "This read is unavailable under current workspace authority."

/** Per-invocation check: no cached token/policy authority and no draft activation.
 * Service clients bypass RLS, so every subsequent domain query must retain shop scope.
 * This is a read admission check, not a transaction lock spanning provider requests.
 */
export async function authorizeMcpRead(
  db: SupabaseClient,
  context: { shopId: string; ownerId: string; tokenId?: string },
  capability: string,
): Promise<boolean> {
  const parsed = contextSchema.safeParse(context)
  const requirements = MCP_READ_REQUIREMENTS[capability]
  if (!parsed.success || !requirements) return false
  const { shopId, ownerId, tokenId } = parsed.data
  try {
    const token = await db.from("mcp_tokens").select("id,shop_id,revoked_at,capabilities").eq("id", tokenId).eq("shop_id", shopId).maybeSingle()
    if (token.error || token.data?.id !== tokenId || token.data.shop_id !== shopId || token.data.revoked_at !== null || !hasMcpCapability(token.data.capabilities, capability)) return false
    const shop = await db.from("shops").select("id,owner_id").eq("id", shopId).maybeSingle()
    if (shop.error || shop.data?.id !== shopId || shop.data.owner_id !== ownerId) return false
    const member = await db.from("shop_memberships").select("user_id,shop_id,role,active").eq("shop_id", shopId).eq("user_id", ownerId).maybeSingle()
    if (member.error || member.data?.user_id !== ownerId || member.data.shop_id !== shopId || member.data.role !== "owner" || member.data.active !== true) return false
    const active = await db.from("control_policy_active").select("shop_id,revision").eq("shop_id", shopId).maybeSingle()
    if (active.error) return false
    // Preserve the existing read baseline until the owner explicitly activates a policy.
    if (!active.data) return true
    if (active.data.shop_id !== shopId || !Number.isInteger(active.data.revision) || active.data.revision < 1) return false
    const history = await db.from("control_policy_history").select("shop_id,revision,definition").eq("shop_id", shopId).eq("revision", active.data.revision).maybeSingle()
    if (history.error || history.data?.shop_id !== shopId || history.data.revision !== active.data.revision) return false
    const policy = policyDraftSchema.safeParse(history.data.definition)
    if (!policy.success || !policy.data.enabled) return false
    const p = policy.data
    // Every non-Off mode includes read authority. Apply all exception/risk ceilings
    // conservatively until trusted per-request classification exists.
    return requirements.every(({ operation, connector }) => ![
      p.actionGrants[operation] ?? p.workspaceDefault ?? ACTIONS[operation].initial,
      p.workspaceCeiling, p.locationCeiling, p.roleCeilings.owner,
      p.connectorCeilings[ACTIONS[operation].connector],
      connector ? p.connectorCeilings[connector] : null,
      ...Object.values(p.riskCeilings), ...Object.values(p.exceptionCeilings),
    ].includes("off"))
  } catch {
    return false
  }
}
