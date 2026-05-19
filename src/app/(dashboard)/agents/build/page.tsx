import Link from "next/link"

import { AgentBuilder } from "@/components/gradia/agent-builder"
import { buttonVariants } from "@/components/ui/button"
import { requireShop } from "@/lib/shop"

export const dynamic = "force-dynamic"

export default async function AgentBuildPage() {
  await requireShop()
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
          href="/agents"
          className={buttonVariants({ variant: "ghost" })}
        >
          Back
        </Link>
      </div>
      <AgentBuilder />
    </div>
  )
}
