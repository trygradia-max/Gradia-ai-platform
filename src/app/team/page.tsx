import Link from "next/link"
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
    <main className="mx-auto min-h-screen max-w-3xl space-y-8 p-6">
      <nav className="flex flex-wrap gap-4" aria-label="Your shops">
        {workspaces.map((w) => (
          <Link
            key={w.id}
            className="text-sm underline"
            href={`/team?shop=${w.id}`}
          >
            {w.name} ({w.role})
          </Link>
        ))}
      </nav>
      {workspace && team ? (
        <TeamPanel key={workspace.id} workspace={workspace} data={team} />
      ) : (
        <div>
          <h1 className="text-2xl font-semibold">Your team</h1>
          <p>
            {shop
              ? "This shop is not available to your account."
              : "No active shop membership yet. Accept an invitation below, or create your own shop."}
          </p>
          <Link href="/onboarding?new=1" className="underline">
            Set up your own shop
          </Link>
        </div>
      )}
      <AcceptInvitation />
    </main>
  )
}
