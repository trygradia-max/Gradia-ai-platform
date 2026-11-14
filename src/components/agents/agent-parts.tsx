import Link from "next/link"
import type { BuilderStepKey } from "@/lib/agent-os/definition-dto"
import { GuardedLink } from "@/components/agents/nav-guard"
import { AlertTriangle, CheckCircle2, CircleSlash, Info, ShieldAlert } from "lucide-react"
import type { ReactNode } from "react"

import { ErrorState } from "@/components/gradia/error-state"
import { buttonVariants } from "@/components/ui/button"
import { StatusPill } from "@/components/ui/status-pill"
import { describeBlockers } from "@/lib/agent-os/builder/blocker-copy"
import {
  CONNECTOR_LABELS,
  LIFECYCLE_LABELS,
  MODE_LABELS,
  OPERATION_LABELS,
  PIN_STATUS_LABELS,
  describeSchedule,
  describeToolReason,
  shortHash,
} from "@/lib/agent-os/builder/labels"
import type {
  ActivationEligibilityDto,
  AgentSummaryDto,
  EvaluationDto,
  MemoryPinDto,
  RevisionDto,
  ToolDecisionDto,
} from "@/lib/agent-os/definition-dto"
import { cn } from "@/lib/utils"

/** A failed or forbidden read is never an empty list and never "eligible": it is its own written state. */
export function DtoStateNotice({
  kind,
  retryHref,
  what = "this page",
}: {
  kind: "forbidden" | "unavailable" | "not_found" | "invalid"
  retryHref?: string
  what?: string
}) {
  const copy = {
    forbidden: { title: "You don't have access to this", body: `Your account can't view ${what} in this workspace. Switch workspace or ask the owner.` },
    unavailable: { title: "We couldn't load this right now", body: `Gradia could not read ${what}. This is not an empty result and nothing was changed. Try again in a moment.` },
    not_found: { title: "We couldn't find that", body: `${what.charAt(0).toUpperCase()}${what.slice(1)} doesn't exist in this workspace.` },
    invalid: { title: "That link isn't valid", body: "The address has a malformed agent or revision. Go back to your agents." },
  }[kind]
  return (
    <div className="mx-auto flex min-h-[40vh] max-w-xl items-center justify-center">
      <ErrorState
        title={copy.title}
        description={copy.body}
        action={
          <>
            {kind === "unavailable" && retryHref ? (
              // A plain anchor forces a full reload, so the retry really re-reads the server.
              <a href={retryHref} className={cn(buttonVariants(), "min-h-11")}>
                Try again
              </a>
            ) : null}
            <Link href="/agents" className={cn(buttonVariants({ variant: "outline" }), "min-h-11")}>
              Back to agents
            </Link>
          </>
        }
      />
    </div>
  )
}

export function LifecyclePill({ lifecycle }: { lifecycle: AgentSummaryDto["lifecycle"] }) {
  const meta = LIFECYCLE_LABELS[lifecycle]
  const icon =
    lifecycle === "active" ? <CheckCircle2 className="size-3" aria-hidden /> :
    lifecycle === "blocked" ? <ShieldAlert className="size-3" aria-hidden /> :
    lifecycle === "paused" ? <CircleSlash className="size-3" aria-hidden /> :
    <Info className="size-3" aria-hidden />
  return (
    <StatusPill tone={meta.tone} icon={icon}>
      {meta.label}
    </StatusPill>
  )
}

/** Shown wherever activation could be mistaken for a live, revision-bound runtime. */
export function RuntimeLimitationNote({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground", className)} role="note">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p>
        Saved definitions are Gradia&apos;s source of truth for what an agent may do, but agent runs are not bound to a revision yet, and
        activation stays unavailable until testing and billing are connected. Nothing here sends, books or changes a record.
      </p>
    </div>
  )
}

export function Section({ title, description, children, id }: { title: string; description?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section aria-labelledby={id ? `${id}-title` : undefined} className="space-y-3">
      <div className="space-y-1">
        <h2 id={id ? `${id}-title` : undefined} className="text-base font-semibold text-foreground">
          {title}
        </h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

export function HashValue({ hash }: { hash: string }) {
  return (
    <span className="font-data text-xs" title={hash}>
      <span aria-hidden>{shortHash(hash)}…</span>
      <span className="sr-only">Definition hash {hash}</span>
    </span>
  )
}

export function BlockerList({ eligibility, builderHref, onStep }: { eligibility: ActivationEligibilityDto; builderHref?: string; onStep?: (step: BuilderStepKey) => void }) {
  if (eligibility.alreadyActive) {
    return <p className="text-sm text-foreground">This exact revision is already the active definition.</p>
  }
  const entries = describeBlockers(eligibility.blockers)
  if (entries.length === 0) {
    return eligibility.eligible ? (
      <p className="text-sm text-foreground">Every check Gradia can make passes for this revision.</p>
    ) : (
      <p className="text-sm text-muted-foreground">Readiness could not be confirmed. Nothing is eligible until it is.</p>
    )
  }
  return (
    <ul className="space-y-2">
      {entries.map(({ code, copy }) => (
        <li key={code} className="flex items-start gap-2 rounded-md bg-status-warning-bg px-3 py-2 text-sm text-status-warning-fg">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="space-y-0.5">
            <p className="font-medium">
              {copy.title} <span className="sr-only">({code})</span>
            </p>
            <p>{copy.detail}</p>
            {copy.action?.step && onStep ? (
              <button type="button" onClick={() => onStep(copy.action!.step as BuilderStepKey)} className="inline-block py-2 text-left underline underline-offset-2">
                {copy.action.label}
              </button>
            ) : copy.action?.step && builderHref ? (
              <GuardedLink href={`${builderHref}&step=${copy.action.step}`} className="inline-block py-2 underline underline-offset-2">
                {copy.action.label}
              </GuardedLink>
            ) : copy.action?.href ? (
              <GuardedLink href={copy.action.href} className="inline-block py-2 underline underline-offset-2">
                {copy.action.label}
              </GuardedLink>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

export function ToolDecisionList({ tools }: { tools: ToolDecisionDto[] }) {
  if (tools.length === 0) return <p className="text-sm text-muted-foreground">No tools selected. This agent can read nothing and do nothing yet.</p>
  return (
    <ul className="divide-y divide-border rounded-md ring-1 ring-border">
      {tools.map((tool) => (
        <li key={tool.operation} className="space-y-1 px-3 py-2.5 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium text-foreground">{OPERATION_LABELS[tool.operation].label}</p>
            <StatusPill tone={tool.available ? "good" : "warn"} icon={tool.available ? <CheckCircle2 className="size-3" aria-hidden /> : <AlertTriangle className="size-3" aria-hidden />}>
              {tool.available ? "Available" : "Blocked"}
            </StatusPill>
          </div>
          <p className="text-xs text-muted-foreground">
            {CONNECTOR_LABELS[tool.connector as keyof typeof CONNECTOR_LABELS] ?? "Connection"} · Requested up to {MODE_LABELS[tool.requestedMaximumMode].toLowerCase()} · Effective now {MODE_LABELS[tool.effectiveMode].toLowerCase()}
          </p>
          {tool.reasons.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {tool.reasons.map((reason) => (
                <li key={reason}>{describeToolReason(reason)}</li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export function MemoryPinList({ pins }: { pins: MemoryPinDto[] }) {
  if (pins.length === 0) return <p className="text-sm text-muted-foreground">No reviewed knowledge sources are pinned.</p>
  return (
    <ul className="divide-y divide-border rounded-md ring-1 ring-border">
      {pins.map((pin) => {
        const meta = PIN_STATUS_LABELS[pin.status]
        return (
          <li key={pin.sourceId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
            <div>
              <p className="font-medium text-foreground">{pin.sourceName ?? "Unnamed source"}</p>
              <p className="text-xs text-muted-foreground">Pinned to revision {pin.memoryRevision}. {meta.help}</p>
            </div>
            <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
          </li>
        )
      })}
    </ul>
  )
}

export function EvaluationList({ evaluations }: { evaluations: EvaluationDto[] }) {
  if (evaluations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No test evidence for this revision yet. Run the checks from the Test step; a revision can only be activated with a passing result.
      </p>
    )
  }
  return (
    <ul className="divide-y divide-border rounded-md ring-1 ring-border">
      {evaluations.map((evaluation) => (
        <li key={evaluation.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
          <div>
            <p className="font-medium text-foreground">Suite {evaluation.suiteVersion}</p>
            <p className="text-xs text-muted-foreground">
              Pass rate {Math.round(evaluation.passRate * 100)}% · estimated {evaluation.estimatedCredits} credits · {new Date(evaluation.completedAt).toLocaleString("en-US")}
            </p>
          </div>
          <StatusPill tone={evaluation.safetyPassed ? "good" : "bad"}>{evaluation.safetyPassed ? "Safety passed" : "Safety failed"}</StatusPill>
        </li>
      ))}
    </ul>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  )
}

/** The exact, read-only content of one saved revision. Shared by the detail and revision pages. */
export function RevisionBody({ revision, builderHref }: { revision: RevisionDto; builderHref?: string }) {
  const { definition } = revision
  return (
    <div className="space-y-8">
      <Section id="job" title="Job" description="What this revision is for.">
        <dl className="grid gap-3 sm:grid-cols-2">
          <Fact label="Role">{definition.job.roleLabel}</Fact>
          <Fact label="Goal">{definition.job.goal}</Fact>
        </dl>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">Expected outcomes</h3>
            <ul className="list-disc space-y-1 pl-4 text-sm">{definition.job.expectedOutcomes.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
          <div>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">Stops when</h3>
            <ul className="list-disc space-y-1 pl-4 text-sm">{definition.job.stopConditions.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        </div>
      </Section>

      <Section id="knowledge" title="Knowledge" description="Reviewed sources pinned to exact revisions. Context choices, not permission.">
        <MemoryPinList pins={revision.memoryPins} />
        <p className="text-xs text-muted-foreground">
          Shop knowledge: {definition.knowledge.includeShopKnowledge ? "included" : "not included"} · Customer memory: {definition.knowledge.includeCustomerMemory ? "included" : "not included"} · Up to {definition.knowledge.maxResultsPerQuery} results per lookup
        </p>
      </Section>

      <Section id="tools" title="Tools" description="What this revision requests. Control Center decides what is allowed.">
        <ToolDecisionList tools={revision.tools} />
      </Section>

      <Section id="limits" title="Limits" description="Budgets cap attempts. They don't guarantee outcomes.">
        <dl className="grid gap-3 sm:grid-cols-4">
          <Fact label="Steps per run">{revision.limits.maximumStepsPerRun}</Fact>
          <Fact label="Seconds per run">{revision.limits.maximumRuntimeSeconds}</Fact>
          <Fact label="Credits per run">{revision.limits.maximumCreditsPerRun}</Fact>
          <Fact label="Runs per day">{revision.limits.maximumRunsPerDay}</Fact>
        </dl>
        <p className="text-xs text-muted-foreground">One run at a time.</p>
      </Section>

      <Section id="schedule" title="Schedule">
        <p className="text-sm">{describeSchedule(revision.schedule)}</p>
        <p className="text-xs text-muted-foreground">A schedule never bypasses readiness, consent, approval or production holds.</p>
      </Section>

      <Section id="tests" title="Tests" description="Exact-revision test evidence.">
        <EvaluationList evaluations={revision.evaluations} />
      </Section>

      <Section id="activation" title="Activation">
        {revision.activation ? (
          <dl className="grid gap-3 sm:grid-cols-3">
            <Fact label="Activated">{new Date(revision.activation.activatedAt).toLocaleString("en-US")}</Fact>
            <Fact label="Control Center policy">{revision.activation.policyRevision ?? "Not recorded"}</Fact>
            <Fact label="Knowledge revision">{revision.activation.knowledgeRevision ?? "Not recorded"}</Fact>
            <Fact label="Superseded revision">{revision.activation.fromRevision ?? "None"}</Fact>
            <Fact label="Tools ready at activation">{revision.activation.readyOperations.length}</Fact>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">This revision has never been activated.</p>
        )}
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Checks for this revision right now</h3>
          <BlockerList eligibility={revision.eligibility} builderHref={builderHref} />
        </div>
      </Section>
    </div>
  )
}
