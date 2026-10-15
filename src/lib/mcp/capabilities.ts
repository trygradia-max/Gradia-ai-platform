import { z } from "zod"

/** Explicit grants only. An empty list grants no data reads or proposals. */
export const MCP_CAPABILITIES = [
  "find_customer_by_channel", "search_customer_memory", "search_shop_knowledge",
  "recent_channel_activity", "list_services", "shop_snapshot", "recent_customers",
  "active_leads", "customer_detail", "customer_timeline", "propose_lead",
  "find_or_create_customer", "record_interaction", "propose_booking", "propose_sms", "propose_email",
] as const
export const mcpCapabilitiesSchema = z.array(z.enum(MCP_CAPABILITIES)).max(MCP_CAPABILITIES.length).refine(values => new Set(values).size === values.length)
export type McpCapability = (typeof MCP_CAPABILITIES)[number]
export function hasMcpCapability(grants: unknown, capability: string): boolean {
  const parsed = mcpCapabilitiesSchema.safeParse(grants)
  return parsed.success && parsed.data.some(value => value === capability)
}
