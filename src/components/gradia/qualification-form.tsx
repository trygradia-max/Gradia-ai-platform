"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { updateLeadQualification } from "@/app/actions/lead-qualification"
import { ErrorState } from "@/components/gradia/error-state"
import { FormField } from "@/components/gradia/form-field"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  QUALIFICATION_FIELDS,
  unknownQualificationFields,
  type LeadQualification,
  type QualificationFields,
  type QualificationQuestion,
  type QualificationUpdateResult,
} from "@/lib/lead-qualification"
import {
  QUALIFICATION_FIELD_LABELS,
  QUALIFICATION_SELECT_CLASS,
  QUALIFICATION_SOURCE_LABELS,
  QUALIFICATION_STATUS_LABELS,
  type QualificationServiceOption,
  qualificationSaveOutcome,
} from "@/lib/qualification-review"

function fieldFromStatus(
  name: (typeof QUALIFICATION_FIELDS)[number],
  current: QualificationFields[(typeof QUALIFICATION_FIELDS)[number]],
  status: QualificationFields["service"]["status"]
): QualificationFields[(typeof QUALIFICATION_FIELDS)[number]] {
  if (status === "unknown") return unknownQualificationFields()[name]
  const source = current.source
  const evidence = source === "intake" ? current.evidence_revision : null
  if (name === "service") {
    const field = current as QualificationFields["service"]
    return { status, source, evidence_revision: evidence, service_id: field.service_id, text: field.text }
  }
  if (name === "vehicle_condition") {
    const field = current as QualificationFields["vehicle_condition"]
    return { status, source, evidence_revision: evidence, text: field.text }
  }
  if (name === "timing") {
    const field = current as QualificationFields["timing"]
    return {
      status,
      source,
      evidence_revision: evidence,
      earliest: field.earliest,
      latest: field.latest,
      text: field.text,
    }
  }
  if (name === "location") {
    const field = current as QualificationFields["location"]
    return { status, source, evidence_revision: evidence, type: field.type, area: field.area }
  }
  const field = current as QualificationFields["constraints"]
  return { status, source, evidence_revision: evidence, items: field.items }
}

export function QualificationForm({
  shopId,
  commandId,
  qualification,
  services,
}: {
  shopId: string
  commandId: string
  qualification: LeadQualification
  services: QualificationServiceOption[]
}) {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [fields, setFields] = useState<QualificationFields>(qualification.fields)
  const [questions, setQuestions] = useState<QualificationQuestion[]>(qualification.open_questions)
  const [reviewState, setReviewState] = useState<"in_progress" | "reviewed">(
    qualification.recorded_review_state ?? "in_progress"
  )
  const [activeCommandId, setActiveCommandId] = useState(commandId)
  const [outcome, setOutcome] = useState<QualificationUpdateResult | null>(null)
  const [locked, setLocked] = useState(false)
  const identityBlocked =
    qualification.identity.state !== "identity_linked" || qualification.identity.customer_id === null
  const uncertain = outcome !== null && !outcome.ok && outcome.code === "uncertain"
  const editDisabled = busy || locked || uncertain || identityBlocked || !qualification.can_update
  const failed = outcome !== null && !outcome.ok
  const fieldError =
    failed && outcome.code === "invalid" ? outcome.field : undefined
  const saveCopy = failed ? qualificationSaveOutcome(outcome) : null

  function replaceField<K extends (typeof QUALIFICATION_FIELDS)[number]>(
    name: K,
    next: QualificationFields[K]
  ) {
    setFields((current) => ({ ...current, [name]: next }))
    if (outcome) setActiveCommandId(crypto.randomUUID())
    setOutcome(null)
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        if (busy || locked || !qualification.can_update || identityBlocked || !qualification.identity.customer_id) return
        start(async () => {
          let result: QualificationUpdateResult
          try {
            result = await updateLeadQualification({
              shopId,
              workflowId: qualification.workflow_id,
              commandId: activeCommandId,
              revision: qualification.revision,
              customerId: qualification.identity.customer_id,
              vehicleId: qualification.identity.vehicle_id,
              reviewState,
              fields: trimFields(fields),
              openQuestions: questions.map((question) => ({
                ...question,
                text: question.text.trim(),
                answer: question.answer?.trim() || null,
              })),
            })
          } catch {
            result = { ok: false, code: "uncertain" }
          }
          setOutcome(result)
          if (result.ok) {
            setLocked(true)
            router.refresh()
            return
          }
          if (result.code !== "invalid" && result.code !== "uncertain") setLocked(true)
        })
      }}
    >
      {identityBlocked ? (
        <ErrorState
          compact
          title="Identity must be linked before qualification can be saved."
          description="Finish identity review on this intake. Nothing here creates a customer or starts a message."
        />
      ) : null}
      {qualification.can_update && !identityBlocked ? (
        <FormField
          id="qualification-review-state"
          label="Review declaration"
          hint="Reviewed means you checked this document. It does not mean the lead is ready to quote or book."
        >
          <select
            className={QUALIFICATION_SELECT_CLASS}
            value={reviewState}
            disabled={editDisabled}
            onChange={(event) => {
              setReviewState(event.target.value as "in_progress" | "reviewed")
              if (outcome) setActiveCommandId(crypto.randomUUID())
              setOutcome(null)
            }}
          >
            <option value="in_progress">Save as in progress</option>
            <option value="reviewed">Mark as reviewed</option>
          </select>
        </FormField>
      ) : null}
      {QUALIFICATION_FIELDS.map((name) => (
        <FieldEditor
          key={name}
          name={name}
          field={fields[name]}
          disabled={editDisabled}
          evidenceRevision={qualification.identity.evidence_revision}
          services={services}
          error={fieldError?.startsWith(`fields.${name}`) ? fieldError : undefined}
          onChange={(next) => replaceField(name, next)}
        />
      ))}
      <QuestionsEditor
        questions={questions}
        disabled={editDisabled}
        error={fieldError?.startsWith("open_questions") ? fieldError : undefined}
        onChange={(next) => {
          setQuestions(next)
          if (outcome) setActiveCommandId(crypto.randomUUID())
          setOutcome(null)
        }}
      />
      {saveCopy ? (
        <ErrorState compact title={saveCopy.title} description={saveCopy.description} />
      ) : null}
      {outcome?.ok ? (
        <p role="status" className="text-sm">
          {outcome.status === "already_recorded"
            ? "This save was already recorded. Nothing new was written."
            : "Qualification recorded. No quote, booking, message, or consent change was made."}
        </p>
      ) : null}
      {qualification.can_update && !identityBlocked && !locked ? (
        <Button type="submit" className="min-h-11" disabled={busy}>
          {busy ? "Recording…" : uncertain ? "Retry same save" : "Save qualification"}
        </Button>
      ) : null}
      {locked ? (
        <p className="text-sm text-muted-foreground">
          Saving is locked until you refresh and read the current record.
        </p>
      ) : null}
    </form>
  )
}

function FieldEditor({
  name,
  field,
  disabled,
  evidenceRevision,
  services,
  error,
  onChange,
}: {
  name: (typeof QUALIFICATION_FIELDS)[number]
  field: QualificationFields[(typeof QUALIFICATION_FIELDS)[number]]
  disabled: boolean
  evidenceRevision: number | null
  services: QualificationServiceOption[]
  error?: string
  onChange: (next: QualificationFields[(typeof QUALIFICATION_FIELDS)[number]]) => void
}) {
  const known = field.status !== "unknown"
  return (
    <fieldset className="space-y-3 rounded-md bg-background/40 p-4 ring-1 ring-border">
      <legend className="px-1 font-medium text-foreground">{QUALIFICATION_FIELD_LABELS[name]}</legend>
      <FormField
        id={`qualification-${name}-status`}
        label={`${QUALIFICATION_FIELD_LABELS[name]} status`}
        hint="Unknown means nobody has established this. Do not treat a blank as no."
        error={error}
      >
        <select
          className={QUALIFICATION_SELECT_CLASS}
          value={field.status}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              fieldFromStatus(
                name,
                field,
                event.target.value as QualificationFields["service"]["status"]
              )
            )
          }
        >
          {Object.entries(QUALIFICATION_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </FormField>
      {!known ? (
        <p className="text-sm text-foreground">
          Value: <strong>Unknown</strong>. No source and no answer are recorded.
          {name === "constraints" ? " This is not the same as “no constraints”." : ""}
        </p>
      ) : (
        <>
          <FormField id={`qualification-${name}-source`} label="Source">
            <select
              className={QUALIFICATION_SELECT_CLASS}
              value={field.source ?? ""}
              disabled={disabled}
              onChange={(event) => {
                const source = event.target.value as "customer" | "staff" | "intake" | ""
                onChange({
                  ...field,
                  source: source || null,
                  evidence_revision:
                    source === "intake" ? evidenceRevision : null,
                } as typeof field)
              }}
            >
              <option value="">Choose who recorded this</option>
              {Object.entries(QUALIFICATION_SOURCE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
          {field.source === "intake" ? (
            <p className="text-xs text-muted-foreground">
              Intake source cites evidence revision {field.evidence_revision ?? "missing"}.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {field.source
                ? `Source: ${QUALIFICATION_SOURCE_LABELS[field.source]}`
                : "A known value needs an explicit source."}
            </p>
          )}
          <ValueFields
            name={name}
            field={field}
            disabled={disabled}
            services={services}
            onChange={onChange}
          />
        </>
      )}
    </fieldset>
  )
}

function ValueFields({
  name,
  field,
  disabled,
  services,
  onChange,
}: {
  name: (typeof QUALIFICATION_FIELDS)[number]
  field: QualificationFields[(typeof QUALIFICATION_FIELDS)[number]]
  disabled: boolean
  services: QualificationServiceOption[]
  onChange: (next: QualificationFields[(typeof QUALIFICATION_FIELDS)[number]]) => void
}) {
  if (name === "service") {
    const value = field as QualificationFields["service"]
    return (
      <>
        {services.length > 0 ? (
          <FormField id="qualification-service-id" label="Shop service">
            <select
              className={QUALIFICATION_SELECT_CLASS}
              value={value.service_id ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...value,
                  service_id: event.target.value || null,
                  text: event.target.value
                    ? services.find((item) => item.id === event.target.value)?.name ?? value.text
                    : value.text,
                })
              }
            >
              <option value="">No shop service selected</option>
              {services.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </FormField>
        ) : null}
        <FormField id="qualification-service-text" label="Service text" hint="Required if no shop service is selected.">
          <Input
            className="h-11"
            maxLength={200}
            value={value.text ?? ""}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...value, text: event.target.value ? event.target.value : null })
            }
          />
        </FormField>
      </>
    )
  }
  if (name === "vehicle_condition") {
    const value = field as QualificationFields["vehicle_condition"]
    return (
      <FormField id="qualification-condition-text" label="Condition">
        <Textarea
          maxLength={1000}
          value={value.text ?? ""}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, text: event.target.value ? event.target.value : null })
          }
        />
      </FormField>
    )
  }
  if (name === "timing") {
    const value = field as QualificationFields["timing"]
    return (
      <>
        <FormField id="qualification-timing-earliest" label="Earliest date">
          <Input
            type="date"
            className="h-11"
            value={value.earliest ?? ""}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...value, earliest: event.target.value || null })
            }
          />
        </FormField>
        <FormField id="qualification-timing-latest" label="Latest date">
          <Input
            type="date"
            className="h-11"
            value={value.latest ?? ""}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...value, latest: event.target.value || null })
            }
          />
        </FormField>
        <FormField id="qualification-timing-text" label="Timing notes">
          <Input
            className="h-11"
            maxLength={300}
            value={value.text ?? ""}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...value, text: event.target.value ? event.target.value : null })
            }
          />
        </FormField>
      </>
    )
  }
  if (name === "location") {
    const value = field as QualificationFields["location"]
    return (
      <>
        <FormField id="qualification-location-type" label="Location type">
          <select
            className={QUALIFICATION_SELECT_CLASS}
            value={value.type ?? ""}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...value,
                type: event.target.value === "shop" || event.target.value === "mobile"
                  ? event.target.value
                  : null,
              })
            }
          >
            <option value="">Choose shop or mobile</option>
            <option value="shop">Shop</option>
            <option value="mobile">Mobile</option>
          </select>
        </FormField>
        <FormField id="qualification-location-area" label="Area">
          <Input
            className="h-11"
            maxLength={200}
            value={value.area ?? ""}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...value, area: event.target.value ? event.target.value : null })
            }
          />
        </FormField>
      </>
    )
  }
  const value = field as QualificationFields["constraints"]
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        A known empty list means there are no constraints. Unknown above means nobody has asked.
      </p>
      {value.items.map((item, index) => (
        <FormField key={`constraint-${index}`} id={`qualification-constraint-${index}`} label={`Constraint ${index + 1}`}>
          <Input
            className="h-11"
            maxLength={200}
            value={item}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...value,
                items: value.items.map((entry, entryIndex) =>
                  entryIndex === index ? event.target.value : entry
                ),
              })
            }
          />
        </FormField>
      ))}
      {value.items.length < 10 ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={disabled}
          onClick={() => onChange({ ...value, items: [...value.items, "New constraint"] })}
        >
          Add constraint
        </Button>
      ) : null}
    </div>
  )
}

function QuestionsEditor({
  questions,
  disabled,
  error,
  onChange,
}: {
  questions: QualificationQuestion[]
  disabled: boolean
  error?: string
  onChange: (next: QualificationQuestion[]) => void
}) {
  return (
    <fieldset className="space-y-3 rounded-md bg-background/40 p-4 ring-1 ring-border">
      <legend className="px-1 font-medium text-foreground">Open questions</legend>
      {error ? (
        <p role="alert" className="text-xs text-status-danger-fg">
          {error}
        </p>
      ) : null}
      {questions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No reviewer questions recorded.</p>
      ) : (
        questions.map((question, index) => (
          <div key={question.id} className="space-y-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
            <FormField id={`qualification-question-text-${question.id}`} label={`Question ${index + 1}`}>
              <Textarea
                maxLength={500}
                value={question.text}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    questions.map((item) =>
                      item.id === question.id ? { ...item, text: event.target.value } : item
                    )
                  )
                }
              />
            </FormField>
            <FormField id={`qualification-question-status-${question.id}`} label="Question status">
              <select
                className={QUALIFICATION_SELECT_CLASS}
                value={question.status}
                disabled={disabled}
                onChange={(event) => {
                  const status = event.target.value as QualificationQuestion["status"]
                  onChange(
                    questions.map((item) =>
                      item.id === question.id
                        ? { ...item, status, answer: status === "answered" ? item.answer : null }
                        : item
                    )
                  )
                }}
              >
                <option value="open">Open</option>
                <option value="answered">Answered</option>
                <option value="dropped">Dropped</option>
              </select>
            </FormField>
            {question.status === "answered" ? (
              <FormField id={`qualification-question-answer-${question.id}`} label="Answer">
                <Textarea
                  maxLength={1000}
                  value={question.answer ?? ""}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(
                      questions.map((item) =>
                        item.id === question.id
                          ? { ...item, answer: event.target.value ? event.target.value : null }
                          : item
                      )
                    )
                  }
                />
              </FormField>
            ) : null}
          </div>
        ))
      )}
      {questions.length < 20 ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={disabled}
          onClick={() =>
            onChange([
              ...questions,
              { id: crypto.randomUUID(), text: "New question", status: "open", answer: null },
            ])
          }
        >
          Add question
        </Button>
      ) : null}
    </fieldset>
  )
}

export function QualificationLockedNotice({
  result,
}: {
  result: Extract<QualificationUpdateResult, { ok: false }>
}) {
  const copy = qualificationSaveOutcome(result)
  return <ErrorState compact title={copy.title} description={copy.description} />
}

function trimFields(fields: QualificationFields): QualificationFields {
  const trim = (value: string | null) => {
    const next = value?.trim() ?? ""
    return next ? next : null
  }
  return {
    service: { ...fields.service, text: trim(fields.service.text) },
    vehicle_condition: { ...fields.vehicle_condition, text: trim(fields.vehicle_condition.text) },
    timing: { ...fields.timing, text: trim(fields.timing.text) },
    location: { ...fields.location, area: trim(fields.location.area) },
    constraints: {
      ...fields.constraints,
      items: fields.constraints.items.map((item) => item.trim()).filter(Boolean),
    },
  }
}
