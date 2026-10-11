import Link from "next/link"
import { SectionHeader } from "@/components/gradia/section-header"
import { TeamChrome } from "@/components/gradia/team-chrome"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { TeamWorkspace } from "@/lib/team-permissions"
import { AcceptInvitation, TeamPanel, type TeamData } from "./team-panel"

export const dynamic = "force-dynamic"
export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ shop?: string }>
}) {
  await requireUser()
  const db = await createClient()
  const { data, error } = await db.rpc("team_workspaces")
  if (error) throw new Error("Team access could not be verified.")
  const workspaces = (data ?? []) as TeamWorkspace[]
  const { shop } = await searchParams
  // Caller-supplied IDs are selectors, never authorization.
  const workspace = shop ? workspaces.find((w) => w.id === shop) : workspaces[0]
  let team: TeamData | null = null
  if (workspace) {
    const results = await Promise.all([
      db
        .from("shop_memberships")
        .select("id,user_id,display_name,role,active,capabilities")
        .eq("shop_id", workspace.id)
        .order("created_at"),
      db
        .from("customers")
        .select("id,name")
        .eq("shop_id", workspace.id)
        .order("created_at", { ascending: false })
        .limit(50),
      db
        .from("appointments")
        .select("id,customer_id,service_name,scheduled_at,status")
        .eq("shop_id", workspace.id)
        .order("scheduled_at", { ascending: false })
        .limit(50),
      db
        .from("shop_assignments")
        .select("id,member_id,customer_id,appointment_id")
        .eq("shop_id", workspace.id),
      workspace.role === "owner"
        ? db.rpc("team_list_invites", { p_shop: workspace.id })
        : Promise.resolve({ data: [], error: null }),
      workspace.role === "owner"
        ? db
            .from("shop_team_audit")
            .select("id,actor_id,event,created_at")
            .eq("shop_id", workspace.id)
            .order("created_at", { ascending: false })
            .limit(50)
        : Promise.resolve({ data: [], error: null }),
      db
        .from("interactions")
        .select("id,customer_id,content,created_at")
        .eq("shop_id", workspace.id)
        .eq("channel", "note")
        .order("created_at", { ascending: false })
        .limit(100),
    ])
    if (results.some((r) => r.error))
      throw new Error("Team records could not be loaded.")
    team = Object.fromEntries(
      [
        "members",
        "customers",
        "jobs",
        "assignments",
        "invitations",
        "audit",
        "notes",
      ].map((key, i) => [key, results[i].data ?? []])
    ) as TeamData
  }
  return (
    <TeamChrome>
      <nav className="flex flex-wrap gap-4" aria-label="Your shops">
        {workspaces.map((w) => (
          <Link
            key={w.id}
            className="inline-flex min-h-11 items-center text-sm text-accent-text underline-offset-4 hover:underline"
            href={`/team?shop=${w.id}`}
          >
            {w.name} ({w.role})
          </Link>
        ))}
      </nav>
      {workspace ? <Link className="inline-flex min-h-11 items-center text-sm text-accent-text underline-offset-4 hover:underline" href={`/conversations?shop=${workspace.id}`}>Open Whisper conversations</Link> : null}
      {workspace && team ? (
        <TeamPanel key={workspace.id} workspace={workspace} data={team} />
      ) : (
        <div className="space-y-3">
          <SectionHeader
            level={1}
            eyebrow="Team"
            title="Your team"
            subhead={
              shop
                ? "This shop is not available to your account."
                : "No active shop membership yet. Accept an invitation below, or create your own shop."
            }
          />
          <Link href="/onboarding?new=1" className="inline-flex min-h-11 items-center text-sm text-accent-text underline-offset-4 hover:underline">
            Set up your own shop
          </Link>
        </div>
      )}
      {workspace && (workspace.role === "owner" || (workspace.role === "manager" && workspace.capabilities.includes("crm.read"))) ? <Link href={`/intake?shop=${workspace.id}`} className="block min-h-11 text-sm text-accent-text underline-offset-4 hover:underline">Review unresolved intake</Link> : null}
      {workspace && (workspace.role === "owner" || (workspace.role === "manager" && workspace.capabilities.includes("crm.read") && workspace.capabilities.includes("delivery.reconcile"))) ? <Link href={`/team/delivery-reviews?shop=${workspace.id}`} className="block min-h-11 text-sm text-accent-text underline-offset-4 hover:underline">Review held message delivery</Link> : null}
      {workspace && workspace.role === "manager" && workspace.capabilities.includes("crm.read") && workspace.capabilities.includes("approvals.messages") ? <Link href={`/team/approvals?shop=${workspace.id}`} className="block min-h-11 text-sm text-accent-text underline-offset-4 hover:underline">Approve queued messages</Link> : null}
      <AcceptInvitation />
    </TeamChrome>
  )
}
