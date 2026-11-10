"use client"

import { GuardedLink, NavGuardProvider } from "@/components/agents/nav-guard"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Circle, CircleAlert, ExternalLink, Lock } from "lucide-react"

import {
  activateAgentDefinitionRevision,
  getActivationEligibility,
  saveAgentDefinitionRevision,
} from "@/app/actions/agent-definitions"
import { BlockerList, DtoStateNotice, LifecyclePill, RuntimeLimitationNote } from "@/components/agents/agent-parts"
import { JobStep, KnowledgeStep, LimitsStep, ScheduleStep, TestStep, ToolsStep } from "@/components/agents/builder-steps"
import { Button, buttonVariants } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { StatusPill } from "@/components/ui/status-pill"
import { describeBlockers } from "@/lib/agent-os/builder/blocker-copy"
import {
  createRequestIdTracker,
  deriveDefinitionKey,
  fromDefinition,
  isDirty,
  saveFingerprint,
  seedForm,
  toDefinitionInput,
  type FieldErrors,
  type FormState,
} from "@/lib/agent-os/builder/form"
import { interpretActivation, interpretSave, type ActivateOutcome } from "@/lib/agent-os/builder/results"
import { STEP_META, STEP_ORDER, STEP_STATUS_LABEL, nextStep, previousStep } from "@/lib/agent-os/builder/steps"
import type {
  ActivationEligibilityDto,
  BuilderResumeDto,
  BuilderStepKey,
  DtoResult,
  EvaluationDto,
  StepStatus,
  ToolDecisionDto,
} from "@/lib/agent-os/definition-dto"
import type { MemoryCatalogDto } from "@/lib/agent-os/identity-store"
import { cn } from "@/lib/utils"

export type BuilderProps = {
  resume: BuilderResumeDto
  initialStep: BuilderStepKey
  catalog: DtoResult<MemoryCatalogDto>
  /** Tool decisions Gradia confirmed for the latest saved revision, or null if they could not be read. */
  confirmedTools: ToolDecisionDto[] | null
  evaluations: EvaluationDto[]
  /** Set by the redirect after a save so the confirmation survives the server refresh. A notice only, never truth. */
  justSaved?: "created" | "replayed" | null
}

function stepForErrorPath(path: string): BuilderStepKey {
  if (path.startsWith("knowledge")) return "knowledge"
  if (path.startsWith("tools")) return "tools"
  if (path.startsWith("limits") || path.startsWith("routing")) return "limits"
  if (path.startsWith("schedule")) return "schedule"
  return "job"
}

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === "complete") return <CheckCircle2 className="size-4 text-status-success-fg" aria-hidden />
  if (status === "blocked") return <Lock className="size-4 text-status-danger-fg" aria-hidden />
  if (status === "attention") return <CircleAlert className="size-4 text-status-warning-fg" aria-hidden />
  return <Circle className="size-4 text-muted-foreground" aria-hidden />
}

export function DefinitionBuilder({ resume, initialStep, catalog, confirmedTools, evaluations, justSaved = null }: BuilderProps) {
  const router = useRouter()
  const latest = resume.latestRevision
  const baseline = useMemo(() => (latest ? fromDefinition(latest.definition) : seedForm(deriveDefinitionKey(resume.name, resume.agentId))), [latest, resume.name, resume.agentId])
  const [form, setForm] = useState<FormState>(baseline)
  const [saved, setSaved] = useState<FormState>(baseline)
  const [step, setStep] = useState<BuilderStepKey>(initialStep)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [notice, setNotice] = useState<{ tone: "good" | "bad"; text: string } | null>(() =>
    justSaved && latest
      ? { tone: "good", text: justSaved === "created" ? `Saved as revision ${latest.revision}.` : `This exact change was already saved as revision ${latest.revision}. Nothing new was created.` }
      : null
  )
  const [conflict, setConflict] = useState(false)
  const [pending, startTransition] = useTransition()
  const [leaveTo, setLeaveTo] = useState<string | null>(null)
  const tracker = useRef(createRequestIdTracker(() => crypto.randomUUID()))
  const headingRef = useRef<HTMLDivElement>(null)
  // Set when the owner deliberately discards edits (Reload latest), so the leave prompt stays quiet.
  const discarding = useRef(false)

  const dirty = isDirty(form, saved)
  const readOnly = !resume.canEdit
  const catalogData = catalog.status === "ok" ? catalog.data : null

  // Leaving the page with unsaved edits asks first. There is no autosave.
  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      if (discarding.current) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [dirty])

  const goToStep = useCallback(
    (target: BuilderStepKey) => {
      setStep(target)
      const url = new URL(window.location.href)
      url.searchParams.set("step", target)
      url.searchParams.delete("saved")
      window.history.replaceState(null, "", url)
      requestAnimationFrame(() => headingRef.current?.querySelector<HTMLElement>("[data-step-heading]")?.focus())
    },
    []
  )


  const saveRevision = (advanceTo?: BuilderStepKey) => {
    if (readOnly || pending) return
    const built = toDefinitionInput(form)
    if (!built.ok) {
      setErrors(built.errors)
      setNotice({ tone: "bad", text: "Some fields need attention before this can be saved." })
      const first = Object.keys(built.errors)[0]
      if (first) goToStep(stepForErrorPath(first))
      return
    }
    setErrors({})
    const parent = latest?.revision ?? null
    const requestId = tracker.current.idFor(saveFingerprint(resume.agentId, parent, built.definition))
    const snapshotAtSave = form
    startTransition(async () => {
      let outcome: ReturnType<typeof interpretSave>
      try {
        outcome = interpretSave(await saveAgentDefinitionRevision({ agentId: resume.agentId, requestId, definition: built.definition, parentRevision: parent, expectedLatestRevision: parent }))
      } catch {
        outcome = { kind: "error", message: "Gradia could not save right now. Nothing was changed. Try again.", retryable: true }
      }
      if (outcome.kind === "saved") {
        tracker.current.settle()
        setConflict(false)
        setSaved(snapshotAtSave)
        setNotice({
          tone: "good",
          text: outcome.outcome === "created" ? `Saved as revision ${outcome.revision}.` : `This exact change was already saved as revision ${outcome.revision}. Nothing new was created.`,
        })
        const target = advanceTo ?? step
        const url = `/agents/build?agent=${resume.agentId}&step=${target}&saved=${outcome.outcome}`
        router.replace(url, { scroll: false })
        setStep(target)
        return
      }
      if (outcome.kind === "conflict") {
        setConflict(true)
        setNotice(null)
        return
      }
      setNotice({ tone: "bad", text: outcome.message })
    })
  }

  const onContinue = () => {
    const target = nextStep(step)
    if (!target) return
    // With no saved revision yet, Continue must validate and save rather than skip ahead.
    if (readOnly || (!dirty && latest)) {
      goToStep(target)
      return
    }
    saveRevision(target)
  }

  const stepStatuses = resume.steps
  const stepNumber = STEP_ORDER.indexOf(step) + 1
  const needsSave = step !== "test" && step !== "activate"

  return (
    <NavGuardProvider value={{ dirty, requestLeave: setLeaveTo }}>
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <GuardedLink
            href={`/agents/${resume.agentId}`}
            className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline sm:min-h-8"
          >
            <ArrowLeft className="size-4" aria-hidden /> {resume.name}
          </GuardedLink>
          {latest || resume.governance === "governed" ? <LifecyclePill lifecycle={resume.lifecycle} /> : <StatusPill tone="muted">No revision saved yet</StatusPill>}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Build {resume.name}</h1>
        <p className="text-sm text-muted-foreground">
          {latest ? `Editing from revision ${latest.revision}. Every save creates a new immutable revision.` : "No revision saved yet. Your first save creates revision 1."}
        </p>
      </header>

      {readOnly ? (
        <div role="note" className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            {resume.editBlockedReason === "legacy_agent_enabled"
              ? "This is a legacy agent and it is turned on. Turn it off from the Receptionist page before saving its first governed revision. You can look around, but nothing here can be changed."
              : "Only the workspace owner can edit or activate agents. You can review every step."}
          </p>
        </div>
      ) : null}

      {conflict ? (
        <div role="alert" className="space-y-2 rounded-md bg-status-warning-bg px-4 py-3 text-sm text-status-warning-fg">
          <p className="font-medium">This agent changed somewhere else.</p>
          <p>Another tab or person saved a newer revision, so your change was not saved and nothing was overwritten. Reload to see the latest. Reloading discards the edits on this page.</p>
          <Button type="button" variant="outline" className="min-h-11" onClick={() => {
              discarding.current = true
              window.location.assign(`/agents/build?agent=${resume.agentId}&step=${step}`)
            }}>
            Reload latest
          </Button>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
        {/* Desktop rail */}
        <nav aria-label="Builder steps" className="hidden lg:block">
          <ol className="space-y-1">
            {STEP_ORDER.map((key, index) => {
              const status = stepStatuses[key]
              const current = key === step
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => goToStep(key)}
                    aria-current={current ? "step" : undefined}
                    className={cn("flex min-h-11 w-full items-center gap-3 rounded-sm px-3 py-2 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50", current ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}
                  >
                    <StatusIcon status={status} />
                    <span className="min-w-0 flex-1">
                      <span className="block">
                        {index + 1}. {STEP_META[key].label}
                      </span>
                      <span className="block text-xs font-normal text-muted-foreground">{STEP_STATUS_LABEL[status]}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>

        {/* Mobile compact progress */}
        <nav aria-label="Builder steps" className="lg:hidden">
          <p className="mb-2 text-sm font-medium text-foreground" aria-live="polite">
            Step {stepNumber} of {STEP_ORDER.length}: {STEP_META[step].label}
          </p>
          <ol className="grid grid-cols-7 gap-1">
            {STEP_ORDER.map((key) => {
              const current = key === step
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => goToStep(key)}
                    aria-current={current ? "step" : undefined}
                    aria-label={`${STEP_META[key].label}, ${STEP_STATUS_LABEL[stepStatuses[key]]}`}
                    className={cn("flex h-11 w-full items-center justify-center rounded-sm text-xs outline-none ring-1 ring-border focus-visible:ring-3 focus-visible:ring-ring/50", current ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground")}
                  >
                    <StatusIcon status={stepStatuses[key]} />
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>

        <div className="min-w-0 space-y-6">
          {dirty ? (
            <p role="status" className="flex items-center gap-2 rounded-md bg-status-info-bg px-3 py-2 text-sm text-status-info-fg">
              <AlertTriangle className="size-4" aria-hidden /> You have unsaved changes. Save &amp; Continue creates a new revision.
            </p>
          ) : null}
          {notice ? (
            <p role="status" className={cn("rounded-md px-3 py-2 text-sm", notice.tone === "good" ? "bg-status-success-bg text-status-success-fg" : "bg-status-danger-bg text-status-danger-fg")}>
              {notice.text}
            </p>
          ) : null}

          <div ref={headingRef}>
            <fieldset disabled={readOnly} className="min-w-0 border-0 p-0">
              {step === "job" ? <JobStep form={form} setForm={setForm} errors={errors} disabled={readOnly} /> : null}
              {step === "knowledge" ? <KnowledgeStep form={form} setForm={setForm} errors={errors} disabled={readOnly} catalog={catalogData} savedPins={latest?.memoryPins ?? []} /> : null}
              {step === "tools" ? <ToolsStep form={form} setForm={setForm} errors={errors} disabled={readOnly} saved={Boolean(latest)} savedForm={saved} confirmedTools={confirmedTools} confirmedUnavailable={Boolean(latest) && confirmedTools === null} /> : null}
              {step === "limits" ? <LimitsStep form={form} setForm={setForm} errors={errors} disabled={readOnly} /> : null}
              {step === "schedule" ? <ScheduleStep form={form} setForm={setForm} errors={errors} disabled={readOnly} /> : null}
            </fieldset>
            {step === "test" ? <TestStep evaluations={evaluations} eligibility={resume.eligibility} savedRevision={latest?.revision ?? null} /> : null}
            {step === "activate" ? <ActivateStep resume={resume} dirty={dirty} onStep={goToStep} /> : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <Button type="button" variant="outline" className="min-h-11 gap-1" disabled={!previousStep(step) || pending} onClick={() => previousStep(step) && goToStep(previousStep(step)!)}>
              <ArrowLeft className="size-4" aria-hidden /> Back
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              {needsSave && !readOnly ? (
                <Button type="button" variant="outline" className="min-h-11" disabled={!dirty || pending} onClick={() => saveRevision()}>
                  {pending ? "Saving…" : "Save"}
                </Button>
              ) : null}
              {nextStep(step) ? (
                <Button type="button" className="min-h-11 gap-1" disabled={pending} onClick={onContinue}>
                  {pending ? "Saving…" : needsSave && dirty && !readOnly ? "Save & Continue" : "Continue"}
                  <ArrowRight className="size-4" aria-hidden />
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={leaveTo !== null}
        onOpenChange={(open) => !open && setLeaveTo(null)}
        title="Leave without saving?"
        description="You have changes that aren't saved. If you leave, they're discarded."
        confirmLabel="Leave and discard"
        cancelLabel="Keep editing"
        tone="destructive"
        onConfirm={() => {
          const target = leaveTo
          setLeaveTo(null)
          if (target) {
            setSaved(form)
            router.push(target)
          }
        }}
      />
    </div>
    </NavGuardProvider>
  )
}

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

function ActivateStep({ resume, dirty, onStep }: { resume: BuilderResumeDto; dirty: boolean; onStep: (step: BuilderStepKey) => void }) {
  const router = useRouter()
  const latest = resume.latestRevision
  const [eligibility, setEligibility] = useState<DtoResult<ActivationEligibilityDto> | { status: "idle" }>(
    resume.eligibility ? { status: "ok", data: resume.eligibility } : { status: "idle" }
  )
  const [confirming, setConfirming] = useState(false)
  const [outcome, setOutcome] = useState<ActivateOutcome | { kind: "failed" } | null>(null)
  const [pending, startTransition] = useTransition()
  const [refreshing, startRefresh] = useTransition()

  // Always re-read readiness for the exact latest revision when this step opens. Reading never activates.
  const refresh = useCallback(() => {
    if (!latest) return
    startRefresh(async () => {
      try {
        setEligibility(await getActivationEligibility(resume.agentId, latest.revision))
      } catch {
        setEligibility({ status: "unavailable", reason: "unavailable" })
      }
    })
  }, [latest, resume.agentId])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (!latest) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold" tabIndex={-1} data-step-heading>Activate</h2>
        <p className="text-sm text-muted-foreground">Save the first revision before activating. Activation is always for one exact saved revision.</p>
      </div>
    )
  }

  const data = eligibility.status === "ok" ? eligibility.data : null
  const canActivate = resume.role === "owner" && resume.canEdit && !dirty && Boolean(data?.eligible) && Boolean(data?.sources)

  function confirmActivation() {
    if (!data?.sources || !latest) return
    const sources = data.sources
    startTransition(async () => {
      try {
        // Only the revision, its hash and the pointer the owner saw are sent. All evidence is server-derived.
        const result = await activateAgentDefinitionRevision({
          agentId: resume.agentId,
          revision: latest.revision,
          expectedHash: sources.definitionHash,
          expectedPointer: sources.expectedPointer,
        })
        setOutcome(interpretActivation(result))
        setConfirming(false)
        if (result.ok) router.refresh()
        else refresh()
      } catch {
        setOutcome({ kind: "failed" })
        setConfirming(false)
      }
    })
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-foreground" tabIndex={-1} data-step-heading>Activate</h2>
        <p className="text-sm text-muted-foreground">
          Activation turns on revision {latest.revision} exactly as saved. Only the owner can activate, and Gradia re-checks everything at that moment.
        </p>
      </div>

      {eligibility.status === "idle" || refreshing ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking readiness…
        </p>
      ) : null}
      {eligibility.status === "forbidden" ? <DtoStateNotice kind="forbidden" what="this agent's readiness" /> : null}
      {eligibility.status === "unavailable" ? (
        <div role="alert" className="space-y-2 rounded-md bg-status-warning-bg px-4 py-3 text-sm text-status-warning-fg">
          <p>Gradia couldn&apos;t check readiness right now. Nothing is eligible until it can.</p>
          <Button type="button" variant="outline" className="min-h-11" onClick={refresh}>
            Check again
          </Button>
        </div>
      ) : null}

      {data ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {data.alreadyActive ? <StatusPill tone="good">This revision is active</StatusPill> : data.eligible ? <StatusPill tone="good">Every check passes</StatusPill> : <StatusPill tone="warn">Not ready to activate</StatusPill>}
            <span className="text-xs text-muted-foreground">
              {data.sources ? `${data.sources.activeAgentCount} of ${data.sources.activeAgentLimit} agent slots in use` : null}
            </span>
          </div>
          <BlockerList eligibility={data} builderHref={`/agents/build?agent=${resume.agentId}`} onStep={onStep} />
        </div>
      ) : null}

      {dirty ? (
        <p role="note" className="text-sm text-muted-foreground">
          You have unsaved changes. Save them as a new revision before activating, so you activate exactly what you reviewed.
        </p>
      ) : null}

      {resume.role !== "owner" ? <p className="text-sm text-muted-foreground">Only the workspace owner can activate this agent.</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" className="min-h-11" disabled={refreshing} onClick={refresh}>
          Refresh readiness
        </Button>
        {resume.role === "owner" ? (
          <Button type="button" className="min-h-11" disabled={!canActivate || pending} onClick={() => setConfirming(true)}>
            {pending ? "Activating…" : "Activate this revision"}
          </Button>
        ) : null}
      </div>

      {outcome ? <ActivationResult outcome={outcome} agentId={resume.agentId} /> : null}

      <RuntimeLimitationNote />

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Activate revision ${latest.revision}?`}
        description="This starts the Founder Pilot subscription if one isn't active. Gradia will re-check everything first, and nothing turns on if any check fails."
        confirmLabel="Activate"
        pending={pending}
        onConfirm={confirmActivation}
      />
    </div>
  )
}

function ActivationResult({ outcome, agentId }: { outcome: ActivateOutcome | { kind: "failed" }; agentId: string }) {
  if (outcome.kind === "activated") {
    return (
      <div role="status" className="space-y-2 rounded-md bg-status-success-bg px-4 py-3 text-sm text-status-success-fg">
        <p className="font-medium">{outcome.alreadyActive ? "This revision was already active." : `Revision ${outcome.revision} is active.`}</p>
        <GuardedLink href={`/agents/${agentId}`} className={cn(buttonVariants({ variant: "outline" }), "min-h-11")}>
          View agent
        </GuardedLink>
      </div>
    )
  }
  if (outcome.kind === "forbidden") {
    return (
      <p role="alert" className="rounded-md bg-status-danger-bg px-4 py-3 text-sm text-status-danger-fg">
        Only the workspace owner can activate this agent. Nothing was activated.
      </p>
    )
  }
  if (outcome.kind === "failed") {
    return (
      <p role="alert" className="rounded-md bg-status-danger-bg px-4 py-3 text-sm text-status-danger-fg">
        Gradia couldn&apos;t complete activation. Nothing was activated. Refresh readiness and try again.
      </p>
    )
  }
  const entries = describeBlockers(outcome.reasons)
  return (
    <div role="alert" className="space-y-3 rounded-md bg-status-warning-bg px-4 py-3 text-sm text-status-warning-fg">
      <p className="font-medium">Nothing was activated.</p>
      <ul className="space-y-1.5">
        {entries.map(({ code, copy }) => (
          <li key={code}>
            <span className="font-medium">{copy.title}.</span> {copy.detail}
          </li>
        ))}
      </ul>
      {outcome.checkoutUrl ? (
        <div className="space-y-1">
          <p>Founder Pilot checkout is the next step. Nothing is charged until you finish it, and the agent stays off until payment is confirmed.</p>
          <a href={outcome.checkoutUrl} className={cn(buttonVariants(), "min-h-11 gap-1.5")}>
            Continue to secure Founder Pilot checkout <ExternalLink className="size-4" aria-hidden />
          </a>
        </div>
      ) : null}
    </div>
  )
}
