import Link from "next/link"
import { redirect } from "next/navigation"

import { AgentBuilder } from "@/components/gradia/agent-builder"
import { buttonVariants } from "@/components/ui/button"
import { FEATURES } from "@/lib/features"
import { requireShop } from "@/lib/shop"

export const dynamic = "force-dynamic"

export default async function AgentBuildPage() {
  await requireShop()
  // FOCUS spec §1 — the self-serve scheduled-agent builder is hidden for alpha
  // (flag-gated, reversible). The box's campaign drafting stays.
  if (!FEATURES.workflowBuilder) redirect("/agents")
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Build a new agent
          </h1>
          <p className="text-sm text-muted-foreground">
            Tell us a problem. We&apos;ll plan a workflow you can save and
            tweak.
          </p>
        </div>
        <Link
          href="/receptionist"
          className={buttonVariants({ variant: "ghost" })}
        >
          Back
        </Link>
      </div>
      <AgentBuilder />
    </div>
  )
}
