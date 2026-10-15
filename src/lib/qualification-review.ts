import type {
  LeadQualification,
  QualificationQuestionStageResult,
  QualificationUpdateResult,
  REVIEW_REASONS,
} from "@/lib/lead-qualification"

export const QUALIFICATION_FIELD_LABELS = {
  service: "Service",
  vehicle_condition: "Vehicle condition",
  timing: "Timing",
  location: "Location",
  constraints: "Constraints",
} as const

export const QUALIFICATION_STATUS_LABELS = {
  unknown: "Unknown",
  reported: "Reported",
  confirmed: "Confirmed",
} as const

export const QUALIFICATION_SOURCE_LABELS = {
  customer: "Customer",
  staff: "Staff",
  intake: "Intake submission",
} as const

export const QUALIFICATION_REVIEW_STATE_LABELS = {
  not_started: "Not started",
  in_progress: "In progress",
  reviewed: "Reviewed",
  needs_review: "Needs review",
} as const

export const QUALIFICATION_REVIEW_REASON_COPY = {
  identity_in_review: "Identity is in review or the linked customer is missing.",
  customer_changed: "The linked customer changed since this record was saved.",
  vehicle_changed: "The vehicle link or details changed since this record was saved.",
  new_evidence: "A new submission arrived after this record was saved.",
} as const satisfies Record<(typeof REVIEW_REASONS)[number], string>

export const QUALIFICATION_VEHICLE_UNLINKED_COPY =
  "Vehicle is not confirmed. Link it in intake review — the customer is never asked for it here."

export const QUALIFICATION_NEXT_TARGET_LABELS = {
  service: "Service",
  vehicle_condition: "Vehicle condition",
  timing: "Timing",
  location: "Location",
  constraints: "Constraints",
  open_question: "Open question",
} as const

export const QUALIFICATION_SELECT_CLASS =
  "h-11 w-full rounded-sm border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"

export type QualificationServiceOption = { id: string; name: string }

export function qualificationUpdatedAt(value: string) {
  return new Date(value).toLocaleString("en-US", { timeZone: "UTC" }) + " UTC"
}

export function qualificationProvenanceLabel(field: {
  source: "customer" | "staff" | "intake" | null
  evidence_revision: number | null
}) {
  if (field.source === null) return "No source — this value is unknown."
  const source = QUALIFICATION_SOURCE_LABELS[field.source]
  if (field.source === "intake" && field.evidence_revision !== null) {
    return `Source: ${source} · evidence revision ${field.evidence_revision}`
  }
  return `Source: ${source}`
}

export function qualificationIdentityLine(identity: LeadQualification["identity"]) {
  const customer =
    identity.customer_name?.trim() ||
    (identity.customer_id ? "Unnamed customer" : "No linked customer")
  const vehicle =
    identity.vehicle_status === "confirmed" && identity.vehicle
      ? [identity.vehicle.year, identity.vehicle.make, identity.vehicle.model, identity.vehicle.color]
          .filter(Boolean)
          .join(" · ") || "Confirmed vehicle details missing"
      : identity.vehicle_status === "needs_review"
        ? "Vehicle needs review"
        : "Vehicle not confirmed"
  return `${customer} · ${vehicle}`
}

const RELOAD_CODES = [
  "revision_conflict",
  "command_conflict",
  "customer_changed",
  "vehicle_changed",
  "identity_review_required",
  "not_confirmed",
  "reference_unavailable",
] as const

export function qualificationSaveOutcome(result: Extract<QualificationUpdateResult, { ok: false }>): {
  title: string
  description: string
  reload: boolean
  retrySame: boolean
} {
  if (result.code === "invalid") {
    return {
      title: "This document is not valid.",
      description: `Nothing was saved. Check ${result.field.replaceAll("_", " ")}.`,
      reload: false,
      retrySame: false,
    }
  }
  if (result.code === "forbidden") {
    return {
      title: "You cannot save qualification for this shop.",
      description: "Owner access or a manager qualify grant is required. Refresh to reload your current access.",
      reload: true,
      retrySame: false,
    }
  }
  if (result.code === "uncertain") {
    return {
      title: "Save result is uncertain.",
      description: "No reply was received. Retry this same save, or refresh and compare before editing again.",
      reload: false,
      retrySame: true,
    }
  }
  if (result.code === "revision_conflict") {
    return {
      title: "Someone saved this record since you loaded it.",
      description: "Refresh to load their version. Do not retry this save — it would overwrite their review.",
      reload: true,
      retrySame: false,
    }
  }
  if (result.code === "command_conflict") {
    return {
      title: "This save no longer matches the current review.",
      description: "Refresh and re-read the record before starting a new save.",
      reload: true,
      retrySame: false,
    }
  }
  if (result.code === "identity_review_required") {
    return {
      title: "Identity must be linked before qualification can be saved.",
      description: "Refresh and finish identity review first. Nothing was saved.",
      reload: true,
      retrySame: false,
    }
  }
  if (result.code === "customer_changed") {
    return {
      title: "The linked customer changed while you were reviewing.",
      description: "Refresh and review the current customer before saving again.",
      reload: true,
      retrySame: false,
    }
  }
  if (result.code === "vehicle_changed") {
    return {
      title: "The vehicle link or details changed while you were reviewing.",
      description: "Refresh and review the current vehicle before saving again.",
      reload: true,
      retrySame: false,
    }
  }
  if (result.code === "reference_unavailable") {
    return {
      title: `The ${result.reference} this save named is not available.`,
      description: "Refresh. The customer, vehicle, or service may have been removed or was never valid for this shop.",
      reload: true,
      retrySame: false,
    }
  }
  return {
    title: "The save could not be confirmed.",
    description: "Nothing is assumed saved. Refresh before trying again.",
    reload: true,
    retrySame: false,
  }
}

export function qualificationRequiresReload(
  code: Extract<QualificationUpdateResult, { ok: false }>["code"]
) {
  return (RELOAD_CODES as readonly string[]).includes(code)
}

export const QUALIFICATION_STAGE_CHANNEL_LABELS = {
  sms: "Text message",
  email: "Email",
} as const

/**
 * Owner-language guidance for every queue-for-approval refusal, mirroring
 * the contract's result table. `retrySame` is true only for `uncertain`
 * (retry with the same command id); stale outcomes need a fresh load and a
 * re-proposal, never a blind retry. `hideControl` removes the control for
 * callers who are not the active owner.
 */
export function qualificationStageOutcome(
  result: Extract<QualificationQuestionStageResult, { ok: false }>,
): {
  title: string
  description: string
  retrySame: boolean
  reload: boolean
  hideControl: boolean
} {
  const reload = {
    title: "",
    description: "",
    retrySame: false,
    reload: true,
    hideControl: false,
  }
  if (result.code === "invalid") {
    return {
      title: "This queue request is not valid.",
      description: `Nothing was queued. Check ${result.field.replaceAll("_", " ")}.`,
      retrySame: false,
      reload: false,
      hideControl: false,
    }
  }
  if (result.code === "forbidden") {
    return {
      title: "Only the shop owner can queue a question.",
      description:
        "Reading or recording a qualification is not permission to message. This control is hidden — nothing was queued.",
      retrySame: false,
      reload: false,
      hideControl: true,
    }
  }
  if (result.code === "uncertain") {
    return {
      title: "Queue result is uncertain.",
      description:
        "No reply was received. Retry this same queue request — it keeps its id, so an exact retry can only confirm, never duplicate.",
      retrySame: true,
      reload: false,
      hideControl: false,
    }
  }
  if (result.code === "command_conflict") {
    return {
      title: "This queue id was already used for something else.",
      description:
        "Nothing new was queued. Reload and re-review the suggestion, then start over with a fresh id.",
      retrySame: false,
      reload: true,
      hideControl: false,
    }
  }
  if (result.code === "qualification_changed") {
    return {
      ...reload,
      title: "The qualification moved since this suggestion.",
      description:
        "Reload and re-read the suggestion. The question offered may no longer be the next one.",
    }
  }
  if (result.code === "review_required") {
    return {
      ...reload,
      title: "Intake review comes first.",
      description:
        "Identity, vehicle, or evidence needs review before anything can be queued. Nothing was queued.",
    }
  }
  if (result.code === "question_resolved") {
    return {
      ...reload,
      title: "That is no longer the suggested question.",
      description:
        "The field is known now, the question was closed, or another question comes first. Reload for the current suggestion.",
    }
  }
  if (result.code === "question_pending") {
    return {
      title: "A question for this lead is already waiting.",
      description:
        "Nothing new was queued. Open Approvals to review the waiting question — approval, not another queue, is the next step.",
      retrySame: false,
      reload: false,
      hideControl: false,
    }
  }
  if (result.code === "contact_blocked") {
    return {
      title: "This customer cannot be messaged.",
      description:
        "Do-not-contact, an opt-out, or a suppression applies. There is no override here — nothing was queued.",
      retrySame: false,
      reload: false,
      hideControl: false,
    }
  }
  if (result.code === "channel_unavailable") {
    return {
      title: "That channel is not ready.",
      description:
        "The channel is not connected or texting is not carrier-approved. Check Settings — nothing was queued.",
      retrySame: false,
      reload: false,
      hideControl: false,
    }
  }
  if (result.code === "conversation_changed") {
    return {
      ...reload,
      title: "The conversation moved or has no thread here.",
      description:
        "A new message arrived, the thread was handed off, or this lead has no thread on that channel. Reload the thread before queueing.",
    }
  }
  if (result.code === "recipient_changed") {
    return {
      ...reload,
      title: "The customer's contact changed.",
      description:
        "The phone or email on file no longer matches what was reviewed. Reload before queueing.",
    }
  }
  if (result.code === "policy_blocked") {
    return {
      title: "The active policy does not permit this.",
      description: "Check the Control Center policy state. Nothing was queued.",
      retrySame: false,
      reload: false,
      hideControl: false,
    }
  }
  return {
    title: "Queueing could not be confirmed.",
    description: "Nothing is assumed queued. Reload before trying again.",
    retrySame: false,
    reload: true,
    hideControl: false,
  }
}
