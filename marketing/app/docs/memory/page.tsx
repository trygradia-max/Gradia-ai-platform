import type { Metadata } from "next"

import {
  DocHeader,
  DocProse,
  CheckList,
  Callout,
  DocPager,
} from "@/components/docs/doc-shell"

export const metadata: Metadata = {
  title: "Shared memory — Docs",
  description:
    "One customer record across voice, email, SMS, and DMs. How Gradia's pgvector memory and Ask Gradia BI chat work.",
}

export default function MemoryDoc() {
  return (
    <>
      <DocHeader
        eyebrow="Getting started"
        title="Shared memory"
        intro="Every touchpoint on every channel writes to one record. A caller who emailed two hours ago isn't a stranger — and you can ask the whole history a plain-English question."
      />

      <DocProse>
        <h2>One identity, every channel</h2>
        <p>
          When John calls after he emailed, Gradia flags it:{" "}
          <em>&ldquo;Note: John also emailed 2 hours ago about ceramic
          coating.&rdquo;</em> Phone, email, Instagram, and Facebook all resolve
          to the same customer, so context follows the person — not the channel.
        </p>
        <p>
          Under the hood, every interaction is embedded into a{" "}
          <strong>pgvector</strong> store. That gives each agent retrieval over
          the full relationship — past services, the vehicle, preferences, what
          you quoted last time — so a reply is grounded in your actual history,
          not a generic guess.
        </p>

        <Callout title="No duplicate records">
          Before creating a customer, Gradia checks unified identity first. A
          number, an email, and a DM handle that belong to one person stay one
          person — with a merge tool for the edge cases.
        </Callout>

        <h2>Ask Gradia</h2>
        <p>
          Because it&apos;s all one store, you can ask questions in plain
          English and get live answers from your own data:
        </p>
      </DocProse>

      <CheckList
        items={[
          '"How many leads did we capture today?"',
          '"How much did we make on Teslas this month?"',
          '"Who asked about ceramic and never booked?"',
          '"What\'s on the calendar Saturday?"',
        ]}
      />

      <DocProse>
        <p>
          Ask Gradia runs on a small set of <strong>read-only</strong> tools —
          counts, revenue, schedule, lookups — so a question can never change
          your data. Answers stream back as it works, the way a good partner
          would talk you through the numbers.
        </p>

        <h2>The customer timeline</h2>
        <p>
          Open any customer and every channel collapses into one timeline: the
          call, the follow-up text, the DM, the invoice, the booking. It&apos;s
          the same memory the agents read from — just rendered for you.
        </p>
      </DocProse>

      <DocPager href="/docs/memory" />
    </>
  )
}
