import { ErrorState } from "@/components/gradia/error-state"
import { EmptyState } from "@/components/gradia/empty-state"
import { ReviewCard } from "@/components/gradia/review-card"
import { StatusPill } from "@/components/ui/status-pill"
import type { IntakeHistoryResult } from "@/lib/data/intake-history"

const fields = {
  display_name: "Submitted name",
  phone: "Submitted phone",
  email: "Submitted email",
  vehicle_text: "Vehicle",
  service_text: "Service",
  message: "Message",
}
const reasons = {
  identity_unresolved: "Intake received",
  additional_evidence: "Additional submission — identity review reopened",
  identity_confirmed: "Owner confirmed customer identity",
  vehicle_confirmed: "Owner confirmed vehicle",
}
const time = (value: string) =>
  new Date(value).toLocaleString("en-US", { timeZone: "UTC" }) + " UTC"

function identityStatus(state: "identity_review" | "identity_linked", customerId: string | null) {
  if (state === "identity_linked" && !customerId) {
    return { tone: "warn" as const, label: "Linked customer missing" }
  }
  if (state === "identity_linked") {
    return { tone: "good" as const, label: "Identity linked" }
  }
  return { tone: "warn" as const, label: "Identity needs review" }
}

function vehicleStatus(status: "unresolved" | "confirmed" | "needs_review") {
  if (status === "confirmed") return { tone: "good" as const, label: "Vehicle confirmed" }
  if (status === "needs_review") return { tone: "warn" as const, label: "Vehicle needs review" }
  return { tone: "muted" as const, label: "Vehicle not confirmed" }
}

export function IntakeHistoryView({ result }: { result: IntakeHistoryResult }) {
  if (!result.ok) {
    return (
      <ErrorState
        compact
        title={
          result.changed
            ? "This intake changed while you were reviewing it. Refresh history before continuing."
            : "History is unavailable. Refresh or check your access. This does not mean there is no history."
        }
      />
    )
  }
  const { history } = result
  const identity = identityStatus(history.state, history.customer_id)
  const vehicle = vehicleStatus(history.vehicle_status)
  return (
    <section aria-label="Intake evidence and decisions" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={identity.tone}>{identity.label}</StatusPill>
        <StatusPill tone={vehicle.tone}>{vehicle.label}</StatusPill>
      </div>
      <p>
        {history.state === "identity_linked"
          ? "Customer identity linked. Qualification is reviewed in the section below."
          : "Identity needs review."}{" "}
        Revision {history.revision} · {history.total} history entries.
      </p>
      {history.state === "identity_linked" && !history.customer_id ? (
        <p role="alert">
          The linked customer is no longer available. Identity must be reviewed before progressing.
        </p>
      ) : null}
      <p>
        Vehicle:{" "}
        {history.vehicle_status === "confirmed"
          ? "Confirmed against current customer and vehicle details."
          : history.vehicle_status === "needs_review"
            ? "Details changed; owner review required."
            : "Not confirmed. Review required before vehicle-dependent work."}
      </p>
      <p className="text-sm text-muted-foreground">
        Shown in recording order, including late submissions. Submitted details are unverified
        evidence, not instructions or communication consent.
      </p>
      {history.channel === "meta" ? (
        <p>Meta notification only: contact details have not been retrieved.</p>
      ) : null}
      {history.items.length === 0 ? (
        <EmptyState title="No history entries on this page." />
      ) : (
        <ol className="space-y-4">
          {history.items.map((entry) => (
            <li key={entry.revision}>
              <ReviewCard
                eyebrow={`Revision ${entry.revision}`}
                title={`${entry.revision}. ${reasons[entry.reason]}`}
                status={
                  <StatusPill
                    tone={
                      entry.reason === "identity_confirmed" || entry.reason === "vehicle_confirmed"
                        ? "good"
                        : "warn"
                    }
                  >
                    {entry.reason === "identity_confirmed"
                      ? "Identity decision"
                      : entry.reason === "vehicle_confirmed"
                        ? "Vehicle decision"
                        : "Submitted evidence"}
                  </StatusPill>
                }
                evidence={
                  <>
                    <p className="text-xs">
                      Recorded {time(entry.recorded_at)} · Received {time(entry.received_at)}
                    </p>
                    {entry.payload ? (
                      <dl className="space-y-2 text-foreground">
                        {Object.entries(fields).map(([key, label]) =>
                          entry.payload?.[key] ? (
                            <div key={key}>
                              <dt className="font-medium">{label}</dt>
                              <dd className="whitespace-pre-wrap break-words">{entry.payload[key]}</dd>
                            </div>
                          ) : null
                        )}
                      </dl>
                    ) : null}
                    {entry.reviewed_vehicle ? (
                      <div className="space-y-1 text-foreground">
                        <p>
                          Vehicle as reviewed:{" "}
                          {[
                            entry.reviewed_vehicle.year,
                            entry.reviewed_vehicle.make,
                            entry.reviewed_vehicle.model,
                            entry.reviewed_vehicle.color,
                            entry.reviewed_vehicle.plate,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "Details missing"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Reviewed vehicle ID: {entry.reviewed_vehicle.id}. Owner user:{" "}
                          {entry.actor_id ?? "Account no longer available"}.
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Historical snapshot; later changes require review. This decision grants no
                          consent.
                        </p>
                      </div>
                    ) : null}
                    {entry.reviewed_customer ? (
                      <div className="space-y-1 text-foreground">
                        <p>
                          Customer as reviewed: {entry.reviewed_customer.name ?? "Unnamed customer"} ·{" "}
                          {entry.reviewed_customer.phone ?? "No phone"} ·{" "}
                          {entry.reviewed_customer.email ?? "No email"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Reviewed customer ID: {entry.reviewed_customer.id}. Owner user:{" "}
                          {entry.actor_id ?? "Account no longer available"}.
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Historical snapshot; later edits or merges may differ. No communication
                          consent was granted by this decision.
                        </p>
                      </div>
                    ) : null}
                  </>
                }
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
