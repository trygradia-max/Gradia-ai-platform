import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight } from "lucide-react"

import { AGENTS } from "@/lib/site"
import { AGENT_ICON, AGENT_TILE } from "@/components/icons"
import { cn } from "@/lib/utils"
import {
  DocHeader,
  DocProse,
  Callout,
  DocPager,
} from "@/components/docs/doc-shell"

export const metadata: Metadata = {
  title: "Docs — Overview",
  description:
    "How Gradia works: one agentic brain across voice, email, SMS, and DMs, with human-in-the-loop approval on everything outbound.",
}

export default function DocsOverview() {
  return (
    <>
      <DocHeader
        eyebrow="Overview"
        title="What Gradia is"
        intro="An agentic AI office for auto detailers. One brain, shared memory, across every channel a customer can reach you on — with you approving every move."
      />

      <DocProse>
        <p>
          Gradia is not a chatbot bolted onto your website. It&apos;s a digital
          front office: a set of agents that answer your phone, read your inbox,
          reply to your DMs, and text back leads — all writing to{" "}
          <strong>one shared memory</strong> so a customer is never a stranger,
          no matter which channel they use.
        </p>

        <p>
          Every customer-facing action Gradia takes is{" "}
          <strong>drafted, never sent.</strong> Replies, invoices, bookings, and
          reminders all land in your Slack as a one-tap approval card. You stay
          in control of the thing that matters most in this trade: what your shop
          says, and what it charges.
        </p>

        <Callout title="The one rule that shapes everything">
          Nothing outbound ships without your approval. Gradia speaks as{" "}
          <em>we/us</em> — a partner who did the backend while you did the work
          on the car — and it always signs its name.
        </Callout>

        <h2>The seven agents</h2>
        <p>
          Each agent owns one channel or job, but they all share the same memory
          and the same approval queue. Start with the one that&apos;s bleeding
          you leads today.
        </p>
      </DocProse>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {AGENTS.map((a) => {
          const Icon = AGENT_ICON[a.iconKey]
          return (
            <Link
              key={a.slug}
              href={`/docs/agents/${a.slug}`}
              data-cursor="cta"
              className="group flex items-start gap-3 rounded-2xl border border-border/60 bg-card/40 p-4 transition-colors hover:border-border hover:bg-card"
            >
              <div
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-lg ring-1",
                  AGENT_TILE[a.iconKey]
                )}
              >
                <Icon className="size-4" aria-hidden />
              </div>
              <div className="min-w-0">
                <p className="flex items-center gap-1 font-medium text-foreground">
                  {a.name}
                  <ArrowRight className="size-3.5 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                </p>
                <p className="mt-0.5 text-sm leading-snug text-muted-foreground">
                  {a.oneLiner}
                </p>
              </div>
            </Link>
          )
        })}
      </div>

      <DocPager href="/docs" />
    </>
  )
}
