import { randomUUID } from "node:crypto"
import Link from "next/link"

import { EmptyState } from "@/components/gradia/empty-state"
import { ErrorState } from "@/components/gradia/error-state"
import { IntakeIdentityForm } from "@/components/gradia/intake-identity-form"
import { ReviewCard } from "@/components/gradia/review-card"
import { StatusPill } from "@/components/ui/status-pill"
import type { IntakeCustomer } from "@/lib/intake-identity"
import type { IntakeReviewResult } from "@/lib/data/intake-review"

const channels = {
  sms: "SMS",
  website_form: "Website form",
  meta: "Meta lead notification",
  synthetic: "Test intake",
}

const fields = {
  display_name: "Submitted name",
  phone: "Submitted phone",
  email: "Submitted email",
  vehicle_text: "Vehicle",
  service_text: "Service",
  message: "Message",
}

const historyLink =
  "inline-flex min-h-11 items-center text-sm text-accent-text underline-offset-4 hover:underline"

export function IntakeReviewQueue({
  result,
  shopId,
  compact = false,
  customers,
}: {
  result: IntakeReviewResult
  shopId: string
  compact?: boolean
  customers?: IntakeCustomer[]
}) {
  return (
    <section aria-label="Unresolved intake" className="space-y-4">
      <h2 className="font-display text-xl text-foreground">
        Intake needing identity review
      </h2>
      {!result.ok ? (
        <ErrorState
          compact
          title="Intake could not be loaded. Refresh or ask the owner to check your access. This does not mean the queue is empty."
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {result.queue.total} unresolved {result.queue.total === 1 ? "item" : "items"}.
            Submitted details are unverified; viewing them does not create a customer or grant
            communication consent.
          </p>
          {result.queue.items.length === 0 ? (
            <EmptyState
              title={result.queue.total === 0 ? "No unresolved intake." : "No items on this page."}
              description={
                result.queue.total === 0
                  ? "New website, SMS, and Meta submissions appear here until an owner links an existing customer."
                  : "This page is empty. Use Previous to return to earlier unresolved items."
              }
            />
          ) : (
            <ul className="space-y-3">
              {result.queue.items.map((item) => (
                <li key={item.id}>
                  <ReviewCard
                    eyebrow="Latest submission"
                    title={channels[item.channel]}
                    status={
                      <StatusPill tone="warn">Identity unresolved</StatusPill>
                    }
                    evidence={
                      <>
                        <p>
                          Received{" "}
                          {new Date(item.last_received_at).toLocaleString("en-US", {
                            timeZone: "UTC",
                          })}{" "}
                          UTC · {item.event_count} recorded{" "}
                          {item.event_count === 1 ? "event" : "events"}
                        </p>
                        <details>
                          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-accent-text underline-offset-4 hover:underline">
                            View latest submitted details
                          </summary>
                          <dl className="mt-3 space-y-2 text-sm text-foreground">
                            {Object.entries(fields).map(([key, label]) =>
                              item.payload[key] ? (
                                <div key={key}>
                                  <dt className="font-medium">{label}</dt>
                                  <dd className="whitespace-pre-wrap break-words">
                                    {item.payload[key]}
                                  </dd>
                                </div>
                              ) : null
                            )}
                          </dl>
                          {item.channel === "meta" ? (
                            <p className="mt-2 text-sm">
                              Only notification identifiers have been received. Contact details have
                              not been retrieved from Meta.
                            </p>
                          ) : null}
                          <p className="mt-3 text-sm text-muted-foreground">
                            Identity linking is available to the owner in the full intake queue;
                            dismissal is not available. Any existing customer or conversation record
                            must be checked separately; matching contact text is not proof of identity.
                          </p>
                        </details>
                      </>
                    }
                    actions={
                      <Link className={historyLink} href={`/intake/${item.id}?shop=${shopId}`}>
                        Review full submission and decision history
                      </Link>
                    }
                  >
                    {!compact && customers ? (
                      <IntakeIdentityForm
                        shopId={shopId}
                        workflowId={item.id}
                        revision={item.revision}
                        commandId={randomUUID()}
                        customers={customers}
                      />
                    ) : null}
                  </ReviewCard>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {compact ? (
        <Link className={historyLink} href={`/intake?shop=${shopId}`}>
          Open intake review queue
        </Link>
      ) : null}
    </section>
  )
}
