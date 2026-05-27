import type { Metadata } from "next"

import { ApprovalCard } from "@/components/home/approval-card"
import {
  DocHeader,
  DocProse,
  Callout,
  DocPager,
} from "@/components/docs/doc-shell"

export const metadata: Metadata = {
  title: "Human-in-the-loop — Docs",
  description:
    "Nothing outbound ships without your approval. How Gradia's draft → approve → send model works, and why a human is always in the loop.",
}

export default function HitlDoc() {
  return (
    <>
      <DocHeader
        eyebrow="Getting started"
        title="Human-in-the-loop"
        intro="The principle that shapes every agent: Gradia drafts and proposes, you approve, then it acts. One bad message is real money — so a human is always in the loop."
      />

      <DocProse>
        <h2>Why drafts, not autopilot</h2>
        <p>
          In detailing, the wrong quote or a careless reply costs you the job —
          or worse, costs you money on a bad commitment. Full autonomy is a
          liability. So Gradia is <strong>agentic with guardrails</strong>: it
          does the work of drafting leads, replies, invoices, bookings, and
          reminders, then hands you the decision.
        </p>

        <h2>The flow</h2>
        <p>
          Every channel funnels into the same queue. A message comes in, Gradia
          classifies it, writes it into shared memory, and drafts the response
          in your shop&apos;s voice. That draft becomes an approval card in
          Slack:
        </p>
      </DocProse>

      <div className="my-8">
        <ApprovalCard
          channel="sms"
          customer="Dana W."
          vehicle="Audi Q5"
          inbound="hey do you guys do headlight restoration? how much"
          draft="Hi Dana — yep, we do headlight restoration, $120 for the pair and about an hour. We've got openings Thursday afternoon. Want me to hold one? — Gradia, front desk at Apex Detail"
          meta="Heat: warm · new SMS lead · no prior history"
        />
      </div>

      <DocProse>
        <p>
          You get three choices on every card:
        </p>
        <ul>
          <li>
            <strong>Approve</strong> — Gradia sends it exactly as drafted and
            files the result.
          </li>
          <li>
            <strong>Edit</strong> — tweak the wording first, then send. Gradia
            learns your corrections.
          </li>
          <li>
            <strong>Reject</strong> — drop it. Nothing goes out, but the lead is
            still on the record.
          </li>
        </ul>

        <Callout title="Where approvals live">
          Approvals land in Slack so you can act from your phone between jobs —
          and mirror into the dashboard&apos;s approval queue, with a quick-reply
          UI for SMS when you&apos;d rather send from the desk.
        </Callout>

        <h2>What never needs approval</h2>
        <p>
          Reading, classifying, and remembering. Gradia listens on every channel
          and keeps the record up to date the moment something happens — that
          part is always on. The gate is only on the things that{" "}
          <strong>leave your shop</strong>: outbound messages and money.
        </p>
      </DocProse>

      <DocPager href="/docs/human-in-the-loop" />
    </>
  )
}
