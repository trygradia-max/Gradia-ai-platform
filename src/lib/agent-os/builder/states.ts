import type { DtoResult } from "@/lib/agent-os/definition-dto"

export type PageState = "forbidden" | "unavailable" | "not_found" | "invalid"

/**
 * Build 1 reports a missing agent/revision as `unavailable` with a reason code. The page
 * layer turns the finite reasons into intentional states; an unknown reason stays `unavailable`
 * (retry), never an empty or eligible screen.
 */
export function pageStateFor<T>(result: DtoResult<T>): PageState | null {
  if (result.status === "ok") return null
  if (result.status === "forbidden") return "forbidden"
  if (result.reason === "agent_not_found" || result.reason === "revision_not_found") return "not_found"
  if (result.reason === "invalid_request") return "invalid"
  return "unavailable"
}
