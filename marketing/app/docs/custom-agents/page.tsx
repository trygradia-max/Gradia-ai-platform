import type { Metadata } from "next"

import {
  DocHeader,
  DocProse,
  CheckList,
  Callout,
  DocPager,
} from "@/components/docs/doc-shell"

export const metadata: Metadata = {
  title: "Custom agents — Docs",
  description:
    "Describe a job in plain English and Gradia builds an agent for it — schedule- or event-triggered, with the same human-in-the-loop guardrails.",
}

export default function CustomAgentsDoc() {
  return (
    <>
      <DocHeader
        eyebrow="Going further"
        title="Custom agents"
        intro="The seven core agents cover the front office. When you have a job that's specific to your shop, you build an agent for it — by describing it, not coding it."
      />

      <DocProse>
        <h2>Co-pilot, not a blank canvas</h2>
        <p>
          Tell Gradia the problem in plain English —{" "}
          <em>&ldquo;every Monday, text last month&apos;s ceramic customers a
          maintenance-wash reminder&rdquo;</em> — and it walks you through
          building the agent step by step, checklist-style. You describe the
          outcome; it proposes the trigger, the steps, and the message.
        </p>

        <h2>Two ways an agent fires</h2>
      </DocProse>

      <CheckList
        items={[
          "Scheduled — runs on a cadence (every morning, weekly, monthly)",
          "Event-triggered — fires when something happens (new lead, job marked paid)",
          "Drafts queued for approval, like every other agent",
          "Every run is logged so you can see exactly what it did",
        ]}
      />

      <DocProse>
        <p>
          Whatever the trigger, a custom agent obeys the same rule as the rest:
          anything customer-facing is <strong>drafted and queued</strong>, never
          sent on its own. A run that wants to text twelve people produces twelve
          approval cards — or one batch you can clear in a tap.
        </p>

        <Callout title="Built to swap brains later">
          Custom agents run on the same planner/runtime the core agents use. As
          new tools and channels come online, your custom agents inherit them
          without a rebuild.
        </Callout>

        <h2>Where you build them</h2>
        <p>
          Head to the agent builder in the app. It&apos;s a simple, Lovable-style
          interface — no jargon, no flowchart spaghetti. Describe, review, turn
          it on.
        </p>
      </DocProse>

      <DocPager href="/docs/custom-agents" />
    </>
  )
}
