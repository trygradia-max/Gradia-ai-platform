"use client"

import Link from "next/link"
import { Plus, X } from "lucide-react"
import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react"

import { BlockerList, EvaluationList, RuntimeLimitationNote, ToolDecisionList } from "@/components/agents/agent-parts"
import { FormField } from "@/components/gradia/form-field"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { StatusPill } from "@/components/ui/status-pill"
import { Textarea } from "@/components/ui/textarea"
import {
  CONNECTOR_LABELS,
  EVENT_LABELS,
  MODE_HELP,
  MODE_LABELS,
  OPERATION_LABELS,
  PIN_STATUS_LABELS,
  POST_MVP_OPERATIONS,
  defaultMaximumMode,
  describeSchedule,
  maximumModeChoices,
} from "@/lib/agent-os/builder/labels"
import {
  INTERVAL_BOUNDS,
  JOB_BOUNDS,
  LIMIT_BOUNDS,
  MAX_RESULTS_BOUNDS,
  toDefinitionInput,
  type FieldErrors,
  type FormState,
} from "@/lib/agent-os/builder/form"
import type { ActivationEligibilityDto, EvaluationDto, MemoryPinDto, ToolDecisionDto } from "@/lib/agent-os/definition-dto"
import type { MemoryCatalogDto } from "@/lib/agent-os/identity-store"
import { ACTIONS, type Connector, type Operation } from "@/lib/control-center/policy"

export type StepProps = {
  form: FormState
  setForm: Dispatch<SetStateAction<FormState>>
  errors: FieldErrors
  disabled: boolean
}

const selectClass =
  "h-11 w-full rounded-sm border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive sm:h-8 sm:text-sm dark:bg-input/30"

function StepIntro({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <h2 className="text-lg font-semibold text-foreground" tabIndex={-1} data-step-heading>
        {title}
      </h2>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

const JOB_EXAMPLE = {
  roleLabel: "Quote follow-up",
  goal: "Follow up with customers who asked for a ceramic coating quote and have not replied in three days, and prepare a polite message for the owner to approve.",
  expectedOutcomes: ["Every quiet quote gets one drafted follow-up within a day", "The owner can see which quotes were followed up"],
  stopConditions: ["The customer says stop or asks not to be contacted", "The customer has already booked", "A message would need a price change"],
}

function ListEditor({
  idBase,
  label,
  hint,
  items,
  onChange,
  bounds,
  errors,
  errorPrefix,
  disabled,
  noun,
}: {
  idBase: string
  label: string
  hint: string
  items: string[]
  onChange: (next: string[]) => void
  bounds: { minItems: number; maxItems: number; min: number; max: number }
  errors: FieldErrors
  errorPrefix: string
  disabled: boolean
  noun: string
}) {
  const listError = errors[errorPrefix]
  return (
    <fieldset className="space-y-2" aria-describedby={`${idBase}-hint`}>
      <legend className="text-sm font-medium text-foreground">{label}</legend>
      <p id={`${idBase}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
      {items.map((value, index) => {
        const itemError = errors[`${errorPrefix}.${index}`]
        const id = `${idBase}-${index}`
        return (
          <div key={index} className="space-y-1">
            <div className="flex items-start gap-2">
              <Input
                id={id}
                value={value}
                maxLength={bounds.max}
                disabled={disabled}
                aria-label={`${noun} ${index + 1}`}
                aria-invalid={itemError ? true : undefined}
                aria-describedby={itemError ? `${id}-error` : undefined}
                onChange={(e) => onChange(items.map((v, i) => (i === index ? e.target.value : v)))}
                className="min-h-11 sm:min-h-8"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11 shrink-0 sm:size-8"
                disabled={disabled || items.length <= 1}
                aria-label={`Remove ${noun.toLowerCase()} ${index + 1}`}
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </div>
            {itemError ? (
              <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
                {itemError}
              </p>
            ) : null}
          </div>
        )
      })}
      {listError ? (
        <p role="alert" className="text-xs text-destructive">
          {listError}
        </p>
      ) : null}
      <Button type="button" variant="outline" size="sm" className="min-h-11 gap-1 sm:min-h-7" disabled={disabled || items.length >= bounds.maxItems} onClick={() => onChange([...items, ""])}>
        <Plus className="size-3.5" aria-hidden /> Add {noun.toLowerCase()}
      </Button>
    </fieldset>
  )
}

export function JobStep({ form, setForm, errors, disabled }: StepProps) {
  const set = (patch: Partial<FormState["job"]>) => setForm((f) => ({ ...f, job: { ...f.job, ...patch } }))
  return (
    <div className="space-y-5">
      <StepIntro title="Job">Say what this agent is for, how you will know it worked, and when it must stop. Gradia, not this text, controls what the agent is allowed to do.</StepIntro>
      <FormField id="job-role" label="Role" hint={`${JOB_BOUNDS.roleLabel.min}–${JOB_BOUNDS.roleLabel.max} characters. For example: Quote follow-up.`} error={errors["job.roleLabel"]}>
        <Input value={form.job.roleLabel} disabled={disabled} maxLength={JOB_BOUNDS.roleLabel.max} onChange={(e) => set({ roleLabel: e.target.value })} className="min-h-11 sm:min-h-8" />
      </FormField>
      <FormField id="job-goal" label="Goal" hint={`One clear goal, ${JOB_BOUNDS.goal.min}–${JOB_BOUNDS.goal.max.toLocaleString("en-US")} characters.`} error={errors["job.goal"]}>
        <Textarea value={form.job.goal} disabled={disabled} maxLength={JOB_BOUNDS.goal.max} rows={4} onChange={(e) => set({ goal: e.target.value })} />
      </FormField>
      <ListEditor
        idBase="job-outcome"
        label="Expected outcomes"
        hint={`${JOB_BOUNDS.outcomes.minItems}–${JOB_BOUNDS.outcomes.maxItems} things you can check. Measurable beats vague.`}
        items={form.job.expectedOutcomes}
        onChange={(next) => set({ expectedOutcomes: next })}
        bounds={JOB_BOUNDS.outcomes}
        errors={errors}
        errorPrefix="job.expectedOutcomes"
        disabled={disabled}
        noun="Outcome"
      />
      <ListEditor
        idBase="job-stop"
        label="Stop conditions"
        hint={`${JOB_BOUNDS.stops.minItems}–${JOB_BOUNDS.stops.maxItems} situations where the agent must stop and hand off.`}
        items={form.job.stopConditions}
        onChange={(next) => set({ stopConditions: next })}
        bounds={JOB_BOUNDS.stops}
        errors={errors}
        errorPrefix="job.stopConditions"
        disabled={disabled}
        noun="Stop condition"
      />
      <details className="rounded-md bg-muted px-3 py-2 text-sm">
        <summary className="min-h-8 cursor-pointer font-medium">See an example for a detailing shop</summary>
        <div className="mt-2 space-y-2 text-muted-foreground">
          <p>
            <strong className="text-foreground">{JOB_EXAMPLE.roleLabel}.</strong> {JOB_EXAMPLE.goal}
          </p>
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7" disabled={disabled} onClick={() => set({ ...JOB_EXAMPLE, expectedOutcomes: [...JOB_EXAMPLE.expectedOutcomes], stopConditions: [...JOB_EXAMPLE.stopConditions] })}>
            Use this example
          </Button>
        </div>
      </details>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export function KnowledgeStep({
  form,
  setForm,
  errors,
  disabled,
  catalog,
  savedPins,
}: StepProps & { catalog: MemoryCatalogDto | null; savedPins: MemoryPinDto[] }) {
  const selected = new Set(form.knowledge.sourceIds)
  const pinBySource = new Map(savedPins.map((p) => [p.sourceId, p]))
  const known = new Set(catalog?.sources.map((s) => s.sourceId) ?? [])
  const toggle = (id: string, on: boolean) =>
    setForm((f) => ({ ...f, knowledge: { ...f.knowledge, sourceIds: on ? [...new Set([...f.knowledge.sourceIds, id])] : f.knowledge.sourceIds.filter((v) => v !== id) } }))
  const STATUS_COPY = {
    selectable: "Reviewed and published",
    awaiting_review: "Not published yet. Review and publish it first",
    revoked: "Revoked",
    expired: "Outside its review window",
    not_published: "Not published",
  } as const

  return (
    <div className="space-y-5">
      <StepIntro title="Knowledge">Choose reviewed, published knowledge this agent may read. Drafts and revoked sources can&apos;t be selected as current.</StepIntro>

      {catalog === null ? (
        <div role="alert" className="rounded-md bg-status-warning-bg px-3 py-2 text-sm text-status-warning-fg">
          Gradia couldn&apos;t load your reviewed knowledge right now. This isn&apos;t an empty list. Reload to try again; sources already pinned are shown below.
        </div>
      ) : catalog.sources.length === 0 ? (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          You have no reviewed knowledge yet. You can continue without any. Add and review knowledge in{" "}
          <Link href="/settings" className="underline underline-offset-2">
            Settings
          </Link>
          .
        </p>
      ) : (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-foreground">Reviewed sources</legend>
          <ul className="divide-y divide-border rounded-md ring-1 ring-border">
            {catalog.sources.map((source) => {
              const isOn = selected.has(source.sourceId)
              const selectable = source.status === "selectable"
              const id = `kn-${source.sourceId}`
              return (
                <li key={source.sourceId} className="flex min-h-11 items-start gap-3 px-3 py-2.5">
                  <input
                    id={id}
                    type="checkbox"
                    className="mt-1 size-5 shrink-0 sm:size-4"
                    checked={isOn}
                    disabled={disabled || (!selectable && !isOn)}
                    aria-describedby={`${id}-status`}
                    onChange={(e) => toggle(source.sourceId, e.target.checked)}
                  />
                  <label htmlFor={id} className="min-w-0 flex-1 text-sm">
                    <span className="font-medium text-foreground">{source.name}</span>
                    <span id={`${id}-status`} className="block text-xs text-muted-foreground">
                      {STATUS_COPY[source.status]}
                      {selectable && source.memoryRevision ? ` · current revision ${source.memoryRevision}` : ""}
                    </span>
                  </label>
                  {pinBySource.has(source.sourceId) ? (
                    <StatusPill tone={PIN_STATUS_LABELS[pinBySource.get(source.sourceId)!.status].tone}>{PIN_STATUS_LABELS[pinBySource.get(source.sourceId)!.status].label}</StatusPill>
                  ) : null}
                </li>
              )
            })}
          </ul>
          {catalog.truncated ? <p className="text-xs text-muted-foreground">Showing the first 200 sources.</p> : null}
        </fieldset>
      )}

      {/* A source that is selected but no longer in the catalog stays visible and removable. */}
      {form.knowledge.sourceIds.filter((id) => !known.has(id)).map((id) => (
        <div key={id} className="flex items-center justify-between gap-2 rounded-md bg-status-warning-bg px-3 py-2 text-sm text-status-warning-fg">
          <span>{pinBySource.get(id)?.sourceName ?? "A selected source"} is no longer available.</span>
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7" disabled={disabled} onClick={() => toggle(id, false)}>
            Remove
          </Button>
        </div>
      ))}
      {errors["knowledge.sourceIds"] ? (
        <p role="alert" className="text-xs text-destructive">
          {errors["knowledge.sourceIds"]}
        </p>
      ) : null}

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-foreground">Context choices</legend>
        <p className="text-xs text-muted-foreground">These choose what the agent can look at. They are not consent from a customer and not permission to act.</p>
        <label className="flex min-h-11 items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1 size-5 sm:size-4" disabled={disabled} checked={form.knowledge.includeShopKnowledge} onChange={(e) => setForm((f) => ({ ...f, knowledge: { ...f.knowledge, includeShopKnowledge: e.target.checked } }))} />
          <span>
            <span className="font-medium text-foreground">Use your shop knowledge</span>
            <span className="block text-xs text-muted-foreground">Services, prices and policies you have reviewed and published.</span>
          </span>
        </label>
        <label className="flex min-h-11 items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1 size-5 sm:size-4" disabled={disabled} checked={form.knowledge.includeCustomerMemory} onChange={(e) => setForm((f) => ({ ...f, knowledge: { ...f.knowledge, includeCustomerMemory: e.target.checked } }))} />
          <span>
            <span className="font-medium text-foreground">Use notes about the customer</span>
            <span className="block text-xs text-muted-foreground">Reviewed notes about the person it is helping.</span>
          </span>
        </label>
        <FormField id="kn-max" label="Results per lookup" hint={`${MAX_RESULTS_BOUNDS.min}–${MAX_RESULTS_BOUNDS.max}. More results use more of the agent's budget.`} error={errors["knowledge.maxResultsPerQuery"]}>
          <Input inputMode="numeric" value={form.knowledge.maxResultsPerQuery} disabled={disabled} onChange={(e) => setForm((f) => ({ ...f, knowledge: { ...f.knowledge, maxResultsPerQuery: e.target.value } }))} className="min-h-11 max-w-32 sm:min-h-8" />
        </FormField>
      </fieldset>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const CONNECTOR_ORDER: Connector[] = ["crm", "calendar", "sms", "email", "voice", "memory", "internal", "website", "meta"]
const ALL_OPS = Object.keys(ACTIONS) as Operation[]

export function ToolsStep({
  form,
  setForm,
  errors,
  disabled,
  saved,
  savedForm,
  confirmedTools,
  confirmedUnavailable,
}: StepProps & { saved: boolean; savedForm: FormState; confirmedTools: ToolDecisionDto[] | null; confirmedUnavailable: boolean }) {
  const selected = new Map(form.tools.map((t) => [t.operation, t.maximumMode]))
  const savedModes = new Map(savedForm.tools.map((t) => [t.operation, t.maximumMode]))
  const confirmed = new Map((confirmedTools ?? []).map((t) => [t.operation, t]))
  const toggle = (operation: Operation, on: boolean) =>
    setForm((f) => ({ ...f, tools: on ? [...f.tools.filter((t) => t.operation !== operation), { operation, maximumMode: defaultMaximumMode(operation) }] : f.tools.filter((t) => t.operation !== operation) }))
  const setMode = (operation: Operation, maximumMode: FormState["tools"][number]["maximumMode"]) =>
    setForm((f) => ({ ...f, tools: f.tools.map((t) => (t.operation === operation ? { ...t, maximumMode } : t)) }))

  const available = ALL_OPS.filter((op) => !POST_MVP_OPERATIONS.has(op))
  const unavailable = ALL_OPS.filter((op) => POST_MVP_OPERATIONS.has(op))

  return (
    <div className="space-y-5">
      <StepIntro title="Tools">Choose what this agent may do and the highest level you will allow. Control Center decides what is actually permitted, and it can only lower these choices.</StepIntro>
      <p className="text-xs text-muted-foreground">
        Your choice is a <strong>requested maximum</strong>. What Gradia confirms is shown separately once you save.{" "}
        <Link href="/control-center" className="underline underline-offset-2">
          Open Control Center
        </Link>{" "}
        ·{" "}
        <Link href="/settings" className="underline underline-offset-2">
          Check connections
        </Link>
      </p>
      {confirmedUnavailable ? (
        <div role="alert" className="rounded-md bg-status-warning-bg px-3 py-2 text-sm text-status-warning-fg">
          Gradia couldn&apos;t check what Control Center allows right now. Availability is unknown, not confirmed.
        </div>
      ) : null}
      {errors.tools ? (
        <p role="alert" className="text-xs text-destructive">
          {errors.tools}
        </p>
      ) : null}

      {CONNECTOR_ORDER.map((connector) => {
        const ops = available.filter((op) => ACTIONS[op].connector === connector)
        if (ops.length === 0) return null
        return (
          <fieldset key={connector} className="space-y-1.5">
            <legend className="text-sm font-medium text-foreground">{CONNECTOR_LABELS[connector]}</legend>
            <ul className="divide-y divide-border rounded-md ring-1 ring-border">
              {ops.map((operation) => {
                const isOn = selected.has(operation)
                const id = `tool-${operation}`
                const choices = maximumModeChoices(operation)
                const decision = confirmed.get(operation)
                const unchangedSinceSave = saved && savedModes.get(operation) === selected.get(operation)
                return (
                  <li key={operation} className="space-y-2 px-3 py-2.5">
                    <div className="flex items-start gap-3">
                      <input id={id} type="checkbox" className="mt-1 size-5 shrink-0 sm:size-4" checked={isOn} disabled={disabled} onChange={(e) => toggle(operation, e.target.checked)} aria-describedby={`${id}-help`} />
                      <label htmlFor={id} className="min-w-0 flex-1 text-sm">
                        <span className="font-medium text-foreground">{OPERATION_LABELS[operation].label}</span>
                        <span id={`${id}-help`} className="block text-xs text-muted-foreground">
                          {OPERATION_LABELS[operation].help}
                        </span>
                      </label>
                    </div>
                    {isOn ? (
                      <div className="ml-8 space-y-2">
                        <FormField id={`${id}-mode`} label="Highest level you will allow" hint={MODE_HELP[selected.get(operation)!]}>
                          <select className={selectClass} value={selected.get(operation)} disabled={disabled} onChange={(e) => setMode(operation, e.target.value as FormState["tools"][number]["maximumMode"])}>
                            {choices.map((mode) => (
                              <option key={mode} value={mode}>
                                {MODE_LABELS[mode]}
                              </option>
                            ))}
                          </select>
                        </FormField>
                        {unchangedSinceSave && decision ? (
                          <p className="text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">Confirmed by Gradia:</span> {decision.available ? `available, ${MODE_LABELS[decision.effectiveMode].toLowerCase()}` : "blocked right now"}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">Not confirmed yet. Save to see what Control Center allows.</p>
                        )}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </fieldset>
        )
      })}

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium text-foreground">Not available yet</legend>
        <ul className="divide-y divide-border rounded-md ring-1 ring-border">
          {unavailable.map((operation) => {
            const isOn = selected.has(operation)
            return (
              <li key={operation} className="flex items-start gap-3 px-3 py-2.5">
                <input id={`tool-${operation}`} type="checkbox" className="mt-1 size-5 shrink-0 sm:size-4" checked={isOn} disabled={disabled || !isOn} onChange={() => toggle(operation, false)} aria-describedby={`tool-${operation}-help`} />
                <label htmlFor={`tool-${operation}`} className="min-w-0 flex-1 text-sm">
                  <span className="font-medium text-foreground">{OPERATION_LABELS[operation].label}</span>
                  <span id={`tool-${operation}-help`} className="block text-xs text-muted-foreground">
                    {isOn ? "Already in this revision. Uncheck it to continue; it cannot be activated." : OPERATION_LABELS[operation].help}
                  </span>
                </label>
                <StatusPill tone="muted">Unavailable</StatusPill>
              </li>
            )
          })}
        </ul>
      </fieldset>

      {saved && confirmedTools && confirmedTools.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">What Gradia confirmed for the last saved revision</h3>
          <ToolDecisionList tools={confirmedTools} />
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export function LimitsStep({ form, setForm, errors, disabled }: StepProps) {
  const setLimit = (key: keyof FormState["limits"], value: string) => setForm((f) => ({ ...f, limits: { ...f.limits, [key]: value } }))
  const row = (key: keyof FormState["limits"], label: string, hint: string) => (
    <FormField key={key} id={`limit-${key}`} label={label} hint={`${hint} (${LIMIT_BOUNDS[key].min.toLocaleString("en-US")}–${LIMIT_BOUNDS[key].max.toLocaleString("en-US")})`} error={errors[`limits.${key}`]}>
      <Input inputMode="numeric" value={form.limits[key]} disabled={disabled} onChange={(e) => setLimit(key, e.target.value)} className="min-h-11 max-w-40 sm:min-h-8" />
    </FormField>
  )
  return (
    <div className="space-y-5">
      <StepIntro title="Limits">Budgets cap how much an agent may attempt. They keep cost and risk bounded; they don&apos;t guarantee a good outcome.</StepIntro>
      <div className="grid gap-5 sm:grid-cols-2">
        {row("maximumStepsPerRun", "Steps per run", "Most actions in one run")}
        {row("maximumRuntimeSeconds", "Seconds per run", "Longest a run may take")}
        {row("maximumCreditsPerRun", "Credits per run", "Most usage a single run may consume")}
        {row("maximumRunsPerDay", "Runs per day", "Most runs in a day")}
      </div>
      <p className="text-sm text-muted-foreground">Only one run happens at a time for each agent.</p>
      <FormField id="routing" label="Model choice" hint="Cost-aware uses the least expensive option that clears the quality bar. This doesn't change what the agent is allowed to do.">
        <select className={selectClass} value={form.routing.strategy} disabled={disabled} onChange={(e) => setForm((f) => ({ ...f, routing: { ...f.routing, strategy: e.target.value as FormState["routing"]["strategy"] } }))}>
          <option value="cost_aware">Prefer lower cost</option>
          <option value="quality_first">Prefer best quality</option>
        </select>
      </FormField>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

const UNITS = [
  { key: "minutes", label: "Minutes", factor: 1 },
  { key: "hours", label: "Hours", factor: 60 },
  { key: "days", label: "Days", factor: 1440 },
] as const

function splitInterval(minutes: string): { amount: string; unit: (typeof UNITS)[number]["key"] } {
  const n = Number(minutes)
  if (Number.isInteger(n) && n > 0 && n % 1440 === 0) return { amount: String(n / 1440), unit: "days" }
  if (Number.isInteger(n) && n > 0 && n % 60 === 0) return { amount: String(n / 60), unit: "hours" }
  return { amount: minutes, unit: "minutes" }
}

export function ScheduleStep({ form, setForm, errors, disabled }: StepProps) {
  const interval = form.schedule.kind === "interval" ? splitInterval(form.schedule.everyMinutes) : { amount: "60", unit: "minutes" as const }
  const [unit, setUnit] = useState<(typeof UNITS)[number]["key"]>(interval.unit)
  const factor = UNITS.find((u) => u.key === unit)!.factor
  const setIntervalValue = (amount: string, nextUnit = unit) => {
    const f = UNITS.find((u) => u.key === nextUnit)!.factor
    const minutes = /^\d{1,9}$/.test(amount.trim()) ? String(Number(amount.trim()) * f) : amount
    setForm((state) => ({ ...state, schedule: { kind: "interval", everyMinutes: minutes } }))
  }
  const amount = form.schedule.kind === "interval" ? (/^\d+$/.test(form.schedule.everyMinutes) && Number(form.schedule.everyMinutes) % factor === 0 ? String(Number(form.schedule.everyMinutes) / factor) : form.schedule.everyMinutes) : interval.amount

  return (
    <div className="space-y-5">
      <StepIntro title="Schedule">Choose when this agent may start. A schedule never skips readiness, customer consent, approvals or production holds.</StepIntro>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-foreground">Starts</legend>
        {(
          [
            { kind: "manual", label: "Only when a person starts it", help: "Recommended while you are testing." },
            { kind: "event", label: "When something happens", help: "Starts after a Gradia event. It still follows every approval rule." },
            { kind: "interval", label: "On a repeating interval", help: `Every ${INTERVAL_BOUNDS.min} minutes up to every 7 days.` },
          ] as const
        ).map((option) => (
          <label key={option.kind} className="flex min-h-11 items-start gap-3 rounded-md px-3 py-2 text-sm ring-1 ring-border has-[:checked]:ring-2 has-[:checked]:ring-ring">
            <input
              type="radio"
              name="schedule-kind"
              className="mt-1 size-5 sm:size-4"
              checked={form.schedule.kind === option.kind}
              disabled={disabled}
              onChange={() =>
                setForm((f) => ({ ...f, schedule: option.kind === "manual" ? { kind: "manual" } : option.kind === "event" ? { kind: "event", event: "lead.received" } : { kind: "interval", everyMinutes: "60" } }))
              }
            />
            <span>
              <span className="font-medium text-foreground">{option.label}</span>
              <span className="block text-xs text-muted-foreground">{option.help}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {form.schedule.kind === "event" ? (
        <FormField id="schedule-event" label="Event" hint="The exact event name is shown so you can match it to your Activity feed.">
          <select className={selectClass} value={form.schedule.event} disabled={disabled} onChange={(e) => setForm((f) => ({ ...f, schedule: { kind: "event", event: e.target.value as keyof typeof EVENT_LABELS } }))}>
            {(Object.keys(EVENT_LABELS) as (keyof typeof EVENT_LABELS)[]).map((event) => (
              <option key={event} value={event}>
                {EVENT_LABELS[event].label} ({EVENT_LABELS[event].code})
              </option>
            ))}
          </select>
        </FormField>
      ) : null}

      {form.schedule.kind === "interval" ? (
        <div className="grid max-w-sm grid-cols-[1fr_auto] items-end gap-3">
          <FormField id="schedule-amount" label="Every" error={errors["schedule.everyMinutes"]}>
            <Input inputMode="numeric" value={amount} disabled={disabled} onChange={(e) => setIntervalValue(e.target.value)} className="min-h-11 sm:min-h-8" />
          </FormField>
          <FormField id="schedule-unit" label="Unit">
            <select
              className={selectClass}
              value={unit}
              disabled={disabled}
              onChange={(e) => {
                const next = e.target.value as (typeof UNITS)[number]["key"]
                setUnit(next)
                setIntervalValue(amount, next)
              }}
            >
              {UNITS.map((u) => (
                <option key={u.key} value={u.key}>
                  {u.label}
                </option>
              ))}
            </select>
          </FormField>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {form.schedule.kind === "interval" && errors["schedule.everyMinutes"] ? "Fix the interval to see the summary." : describeScheduleFromForm(form)}
      </p>
    </div>
  )
}

function describeScheduleFromForm(form: FormState): string {
  const parsed = toDefinitionInput({ ...form, job: { roleLabel: "ok", goal: "ok ok ok ok", expectedOutcomes: ["ok ok"], stopConditions: ["ok ok"] } })
  return parsed.ok ? describeSchedule(parsed.definition.schedule) : ""
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

const TEST_SLOTS = [
  "Inputs used, with their sources",
  "Actions the agent would propose",
  "Outcomes that could not be confirmed",
  "Estimated cost of a run",
] as const

export function TestStep({ evaluations, eligibility, savedRevision }: { evaluations: EvaluationDto[]; eligibility: ActivationEligibilityDto | null; savedRevision: number | null }) {
  return (
    <div className="space-y-5">
      <StepIntro title="Test">Before an agent goes live, Gradia checks this exact revision against test cases. A test never sends, books or changes a record.</StepIntro>
      <div className="space-y-2 rounded-md bg-muted px-4 py-3 text-sm" role="status">
        <p className="font-medium text-foreground">Test runner not available yet</p>
        <p className="text-muted-foreground">
          Gradia can&apos;t test this agent today, so no revision can pass a test and activation stays blocked (<span className="font-data">evaluation_required</span>). Nothing here calls a model or records a result.
        </p>
      </div>
      <section aria-label="Test results for the latest saved revision" className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">{savedRevision ? `Results for revision ${savedRevision}` : "Results"}</h3>
        <EvaluationList evaluations={evaluations} />
      </section>
      <section aria-label="What a test will show" className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">What a test will show here</h3>
        <ul className="grid gap-2 sm:grid-cols-2">
          {TEST_SLOTS.map((slot) => (
            <li key={slot} className="rounded-md px-3 py-2 text-sm text-muted-foreground ring-1 ring-border">
              {slot}
              <span className="block text-xs">Appears when the test runner is available.</span>
            </li>
          ))}
        </ul>
      </section>
      {eligibility ? (
        <section aria-label="Current blockers" className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">What is blocking activation</h3>
          <BlockerList eligibility={eligibility} />
        </section>
      ) : null}
      <RuntimeLimitationNote />
    </div>
  )
}
