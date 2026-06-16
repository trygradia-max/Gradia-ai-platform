import Link from "next/link"
import {
  CalendarClock,
  MessagesSquare,
  PhoneCall,
  Send,
  Wand2,
} from "lucide-react"

import { getAutonomyRecommendationsForCurrentShop } from "@/app/actions/autonomy"
import { AgentCard } from "@/components/gradia/agent-card"
import { AutonomyOffers } from "@/components/gradia/autonomy-offers"
import { CapabilityRow } from "@/components/gradia/capability-row"
import { CustomAgentCard } from "@/components/gradia/custom-agent-card"
import { buttonVariants } from "@/components/ui/button"
import { readAutonomy } from "@/lib/autonomy"
import {
  getAgentsForCurrentShop,
  getLatestRunsByAgent,
  listCustomAgentsForCurrentShop,
} from "@/lib/data/agents"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { CustomAgentRow } from "@/lib/types/database"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

/** Reminder-recipe customs live under "Remind customers"; everything else
 *  an owner plans (follow-ups, thank-yous, freeform) is "Follow up". */
function isReminderAgent(agent: CustomAgentRow): boolean {
  const id = agent.config.recipe?.id
  return id === "appointment_reminder_email" || id === "appointment_reminder_sms"
}

export default async function AgentsPage() {
  const [agents, customAgents] = await Promise.all([
    getAgentsForCurrentShop(),
    listCustomAgentsForCurrentShop(),
  ])
  const lastRuns = await getLatestRunsByAgent(customAgents.map((a) => a.id))
  const shopCtx = await requireShop()
  const supabase = await createClient()
  const { data: shopRow } = await supabase
    .from("shops")
    .select("settings")
    .eq("id", shopCtx.id)
    .single()
  const autonomy = readAutonomy({
    settings:
      (shopRow as { settings?: Record<string, unknown> } | null)?.settings ?? {},
  })

  const byId = new Map(agents.map((a) => [a.id, a]))
  const active = (id: string) => byId.get(id)?.status === "active"

  const autonomyOffers = await getAutonomyRecommendationsForCurrentShop()

  const reminderCustoms = customAgents.filter(isReminderAgent)
  const followupCustoms = customAgents.filter((a) => !isReminderAgent(a))
  const enabledCustom = customAgents.filter((a) => a.enabled).length
  const activeCount = agents.filter((a) => a.status === "active").length

  const customCard = (agent: CustomAgentRow) => (
    <CustomAgentCard
      key={agent.id}
      agent={agent}
      lastRun={lastRuns.get(agent.id) ?? null}
      initialMode={autonomy.overrides[agent.id] ?? autonomy.default}
    />
  )

  /** The four capabilities, in owner words (UX spec Part 2). */
  const groups = [
    {
      icon: PhoneCall,
      title: "Answer my calls",
      blurb: "A receptionist that picks up, quotes, and proposes bookings.",
      members: ["voice"],
      customs: [] as CustomAgentRow[],
      readyAction: { label: "Set it up", href: "/settings#voice" },
    },
    {
      icon: MessagesSquare,
      title: "Reply to texts & emails",
      blurb: "Every inbound message gets a drafted reply waiting on your yes.",
      members: ["sms", "email"],
      customs: [] as CustomAgentRow[],
      readyAction: { label: "Connect a channel", href: "/settings#sms" },
    },
    {
      icon: Send,
      title: "Follow up with leads",
      blurb: "Quotes that went quiet and customers we haven't seen in a while.",
      members: ["chat", "memory", "booking"],
      customs: followupCustoms,
      readyAction: { label: "Plan one with us", href: "/agents/build" },
    },
    {
      icon: CalendarClock,
      title: "Remind customers before appointments",
      blurb: "A text or email the day before, so nobody no-shows.",
      members: [],
      customs: reminderCustoms,
      readyAction: { label: "Plan a reminder", href: "/agents/build" },
    },
  ]

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <p className="label-eyebrow text-muted-foreground/70">
            What Gradia does for you
          </p>
          <h1 className="font-display text-[clamp(2rem,5vw,3rem)] leading-[1.05] tracking-[-0.025em] text-foreground">
            What&apos;s <span className="italic">running</span> for us.
          </h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            {`${activeCount} of ${agents.length} built-ins live`}
            {customAgents.length > 0
              ? ` · ${enabledCustom} of ${customAgents.length} custom on`
              : ""}
            . Open a row to tune it, or plan something new from scratch.
          </p>
        </div>
        <Link
          href="/agents/build"
          className={cn(buttonVariants({ size: "lg" }), "h-11 gap-2 shrink-0")}
        >
          <Wand2 className="size-4" aria-hidden />
          Build a new agent
        </Link>
      </header>

      <AutonomyOffers recommendations={autonomyOffers} />

      <div className="space-y-3">
        {groups.map((group) => {
          const builtins = group.members
            .map((id) => byId.get(id))
            .filter((a): a is NonNullable<typeof a> => Boolean(a))
          const onCount =
            builtins.filter((a) => a.status === "active").length +
            group.customs.filter((c) => c.enabled).length
          const total = builtins.length + group.customs.length
          const on =
            group.members.length > 0
              ? group.members.some(active) ||
                group.customs.some((c) => c.enabled)
              : group.customs.some((c) => c.enabled)
          return (
            <CapabilityRow
              key={group.title}
              icon={group.icon}
              title={group.title}
              blurb={group.blurb}
              on={on}
              detail={total > 0 ? `${onCount} of ${total} on` : null}
              readyAction={!on ? group.readyAction : null}
              defaultOpen={false}
            >
              {builtins.map((agent) => (
                <AgentCard key={agent.id} agent={agent} />
              ))}
              {group.customs.map(customCard)}
            </CapabilityRow>
          )
        })}
      </div>
    </div>
  )
}
