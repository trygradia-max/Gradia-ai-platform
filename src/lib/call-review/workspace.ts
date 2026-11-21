import type { TeamWorkspace } from "@/lib/team-permissions"

/**
 * The shop a manager reviews calls for. A presentation selector only: it narrows the signed-in user's own workspace
 * list to the shops where they hold an active manager grant with crm.read. The review function re-checks the live
 * membership and grant in SQL, so a stale or edited `?shop=` can only produce a refusal, never someone else's data.
 */
export function pickReviewWorkspace(workspaces: readonly TeamWorkspace[], shop: string | undefined): TeamWorkspace | null {
  const allowed = workspaces.filter((w) => w.role === "manager" && w.capabilities.includes("crm.read"))
  return (shop ? allowed.find((w) => w.id === shop) : allowed[0]) ?? null
}
