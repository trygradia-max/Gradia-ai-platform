import { ErrorState } from "@/components/gradia/error-state"
import { QualificationForm } from "@/components/gradia/qualification-form"
import { ReviewCard } from "@/components/gradia/review-card"
import { SectionHeader } from "@/components/gradia/section-header"
import { StatusPill } from "@/components/ui/status-pill"
import type {
  LeadQualification,
  LeadQualificationHistory,
} from "@/lib/lead-qualification"
import {
  QUALIFICATION_FIELD_LABELS,
  QUALIFICATION_REVIEW_REASON_COPY,
  QUALIFICATION_REVIEW_STATE_LABELS,
  QUALIFICATION_STATUS_LABELS,
  type QualificationServiceOption,
  qualificationIdentityLine,
  qualificationProvenanceLabel,
  qualificationUpdatedAt,
} from "@/lib/qualification-review"

function reviewTone(state: LeadQualification["review_state"]) {
  if (state === "needs_review") return "warn" as const
  if (state === "reviewed") return "good" as const
  if (state === "in_progress") return "accent" as const
  return "muted" as const
}

function fieldValue(name: keyof typeof QUALIFICATION_FIELD_LABELS, qualification: LeadQualification) {
  const field = qualification.fields[name]
  if (field.status === "unknown") {
    return name === "constraints"
      ? "Unknown — nobody has asked. This is not “no constraints”."
      : "Unknown"
  }
  if (name === "service") {
    const value = qualification.fields.service
    return [value.text, value.service_id ? `Service id ${value.service_id}` : null]
      .filter(Boolean)
      .join(" · ")
  }
  if (name === "vehicle_condition") return qualification.fields.vehicle_condition.text
  if (name === "timing") {
    const value = qualification.fields.timing
    return [value.earliest && `Earliest ${value.earliest}`, value.latest && `Latest ${value.latest}`, value.text]
      .filter(Boolean)
      .join(" · ")
  }
  if (name === "location") {
    const value = qualification.fields.location
    return [value.type, value.area].filter(Boolean).join(" · ")
  }
  const items = qualification.fields.constraints.items
  return items.length === 0 ? "No constraints" : items.join(" · ")
}

export function QualificationReview({
  result,
  history,
  shopId,
  commandId,
  services,
}: {
  result: { ok: true; data: LeadQualification } | { ok: false }
  history: { ok: true; data: LeadQualificationHistory } | { ok: false } | null
  shopId: string
  commandId: string
  services: QualificationServiceOption[]
}) {
  if (!result.ok) {
    return (
      <section id="qualification" className="space-y-4">
        <SectionHeader
          eyebrow="Qualification"
          title="Qualification review"
          subhead="Linked intake details the backend already persists."
        />
        <ErrorState
          compact
          title="Qualification could not be loaded. Refresh or check your access. This does not mean there is no record."
        />
      </section>
    )
  }
  const qualification = result.data
  return (
    <section id="qualification" className="space-y-4">
      <SectionHeader
        eyebrow="Qualification"
        title="Qualification review"
        subhead="Review and edit what is already persisted. Unknown stays unknown. Saving does not quote, book, message, or grant consent."
      />
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={reviewTone(qualification.review_state)}>
          {QUALIFICATION_REVIEW_STATE_LABELS[qualification.review_state]}
        </StatusPill>
        <StatusPill tone={qualification.completeness === "complete" ? "good" : "muted"}>
          {qualification.completeness === "complete" ? "Complete" : "Incomplete"}
        </StatusPill>
        {qualification.can_update ? (
          <StatusPill tone="accent">Can save</StatusPill>
        ) : (
          <StatusPill tone="muted">Read only</StatusPill>
        )}
      </div>
      {qualification.review_state === "needs_review" ? (
        <ErrorState
          compact
          title="This qualification is stale."
          description={
            qualification.review_reasons.length > 0
              ? qualification.review_reasons
                  .map((reason) => QUALIFICATION_REVIEW_REASON_COPY[reason])
                  .join(" ")
              : "Identity, vehicle, or evidence changed since it was recorded. Refresh and re-review before treating it as current."
          }
        />
      ) : null}
      <ReviewCard
        eyebrow={`Revision ${qualification.revision}`}
        title={qualificationIdentityLine(qualification.identity)}
        status={
          <StatusPill tone={qualification.identity.state === "identity_linked" ? "good" : "warn"}>
            {qualification.identity.state === "identity_linked"
              ? "Identity linked"
              : "Identity needs review"}
          </StatusPill>
        }
        evidence={
          <>
            <p>
              {qualification.updated_at
                ? `Last recorded ${qualificationUpdatedAt(qualification.updated_at)}`
                : "Nothing recorded yet"}
              {qualification.updated_by
                ? ` · ${qualification.updated_by.label} (${qualification.updated_by.role})`
                : ""}
              {qualification.identity.evidence_revision
                ? ` · Evidence revision ${qualification.identity.evidence_revision}`
                : ""}
            </p>
            {qualification.missing.length > 0 ? (
              <p>Missing: {qualification.missing.map((name) => name.replaceAll("_", " ")).join(", ")}.</p>
            ) : (
              <p>No missing fields. That is not a quote or booking ready state.</p>
            )}
            <dl className="space-y-3 text-foreground">
              {(Object.keys(QUALIFICATION_FIELD_LABELS) as Array<keyof typeof QUALIFICATION_FIELD_LABELS>).map(
                (name) => (
                  <div key={name}>
                    <dt className="font-medium">
                      {QUALIFICATION_FIELD_LABELS[name]} ·{" "}
                      {QUALIFICATION_STATUS_LABELS[qualification.fields[name].status]}
                    </dt>
                    <dd className="whitespace-pre-wrap break-words">{fieldValue(name, qualification)}</dd>
                    <dd className="text-xs text-muted-foreground">
                      {qualificationProvenanceLabel(qualification.fields[name])}
                    </dd>
                  </div>
                )
              )}
            </dl>
          </>
        }
      />
      {qualification.can_update ? (
        <QualificationForm
          shopId={shopId}
          commandId={commandId}
          qualification={qualification}
          services={services}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Saving is unavailable. Owner access or a manager qualify grant is required.
        </p>
      )}
      <QualificationHistoryView result={history} />
    </section>
  )
}

export function QualificationHistoryView({
  result,
}: {
  result: { ok: true; data: LeadQualificationHistory } | { ok: false } | null
}) {
  if (result === null) return null
  if (!result.ok) {
    return (
      <ErrorState
        compact
        title="Qualification history could not be loaded. This does not mean there is no history."
      />
    )
  }
  const items = result.data.items.slice(0, 20)
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No qualification history entries on this page.</p>
  }
  return (
    <ol className="space-y-3">
      {items.map((entry) => (
        <li key={entry.revision}>
          <ReviewCard
            eyebrow={`Saved revision ${entry.revision}`}
            title={`${entry.actor_label} (${entry.actor_role})`}
            status={
              <StatusPill tone={entry.review_state === "reviewed" ? "good" : "accent"}>
                {QUALIFICATION_REVIEW_STATE_LABELS[entry.review_state]}
              </StatusPill>
            }
            evidence={
              <>
                <p>
                  Recorded {qualificationUpdatedAt(entry.created_at)} · reviewed evidence revision{" "}
                  {entry.reviewed_evidence_revision}
                </p>
                <p>
                  Customer {entry.reviewed_customer_id}
                  {entry.reviewed_vehicle_id ? ` · vehicle ${entry.reviewed_vehicle_id}` : " · no vehicle"}
                </p>
              </>
            }
          />
        </li>
      ))}
    </ol>
  )
}
