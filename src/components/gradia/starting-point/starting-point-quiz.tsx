"use client"

import * as React from "react"
import { AlertTriangle, ArrowLeft, ArrowRight, CircleDashed, Loader2 } from "lucide-react"

import { saveBaselineDraft, submitBaselineAssessment } from "@/app/actions/onboarding-baseline"
import { QuestionField } from "@/components/gradia/starting-point/question-field"
import { Button } from "@/components/ui/button"
import { QUESTION_COPY, QUIZ_STEPS, issueMessage } from "@/lib/onboarding-baseline/copy"
import type { DraftSummary } from "@/lib/onboarding-baseline/dto"
import {
  answersFingerprint,
  answersFromForm,
  describeAnswer,
  formFromAnswers,
  issuesByKey,
  missingRequired,
  progressOf,
  questionsInStep,
  stepOfQuestion,
  validateForm,
  type FieldState,
  type FormState,
} from "@/lib/onboarding-baseline/form-model"
import type { Issue } from "@/lib/onboarding-baseline/validate"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"

const T = STRINGS.pages.startingPoint

export type QuizSeed = {
  role: "owner" | "manager"
  /** The current baseline revision (null before the first submission). The database checks it on submit. */
  baselineRevision: number | null
  /** The server-held draft, if any. It wins over the revision's answers because it is newer work. */
  draft: DraftSummary | null
  /** The current revision's answers, used to start an update. Null before the first submission. */
  revisionAnswers: Record<string, unknown> | null
}

type Phase = "intro" | "quiz" | "review"
type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: string; managerDraft?: boolean }
  | { kind: "error" }
  | { kind: "conflict" }

const PAGES = QUIZ_STEPS.length
const timeNow = () => new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })

/** First page with a blank required question, or the review page when every required question has an answer. */
function firstIncomplete(answers: Record<string, unknown>): number {
  const missing = new Set(missingRequired(answers))
  const idx = QUIZ_STEPS.findIndex((s) => questionsInStep(s).some((q) => missing.has(q.key)))
  return idx === -1 ? PAGES : idx
}

/** Where to open: the intro for a first visit; otherwise the first unanswered page, or Review when everything required is answered. */
function initialPlace(answers: Record<string, unknown>, startAt: "intro" | "quiz", hasSaved: boolean): { phase: Phase; page: number } {
  if (startAt === "intro") return { phase: "intro", page: 0 }
  const idx = hasSaved ? firstIncomplete(answers) : 0
  return idx >= PAGES ? { phase: "review", page: PAGES - 1 } : { phase: "quiz", page: idx }
}

export function StartingPointQuiz({
  seed,
  mode,
  startAt,
  onReload,
  onSubmitted,
  onFinishLater,
  onSkip,
  onBackStep,
  onCancel,
  onForbidden,
}: {
  seed: QuizSeed
  mode: "page" | "wizard"
  startAt: "intro" | "quiz"
  /** Re-read the server state and restart the quiz from it (used after a conflict). */
  onReload: () => void
  onSubmitted: (revision: number) => void
  onFinishLater: () => void
  /** Wizard only: continue setup without a starting point. */
  onSkip?: () => void
  /** Wizard only: return to the previous setup step from the intro. */
  onBackStep?: () => void
  /** Update flow: return to the report without changes. */
  onCancel?: () => void
  /** The database refused this account mid-flow (for example access was revoked). */
  onForbidden: () => void
}) {
  const initialAnswers = seed.draft?.answers ?? seed.revisionAnswers ?? {}
  const [form, setForm] = React.useState<FormState>(() => formFromAnswers(initialAnswers))
  const [draftVersion, setDraftVersion] = React.useState<number | null>(seed.draft?.draftVersion ?? null)
  // What the server already holds, so "Save and continue" only writes when something changed.
  const [savedPrint, setSavedPrint] = React.useState(() => answersFingerprint(answersFromForm(formFromAnswers(initialAnswers)).answers))
  const [place] = React.useState(() => initialPlace(initialAnswers, startAt, Boolean(seed.draft || seed.revisionAnswers)))
  const [phase, setPhase] = React.useState<Phase>(place.phase)
  const [page, setPage] = React.useState(place.page)
  const [showErrors, setShowErrors] = React.useState(false)
  // Issues the screen cannot see on its own: required answers found at submit, or a refusal from the server.
  const [serverIssues, setServerIssues] = React.useState<Issue[]>([])
  const [status, setStatus] = React.useState<Status>({ kind: "idle" })
  const [submitting, setSubmitting] = React.useState(false)
  const busy = React.useRef(false)
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  const summaryRef = React.useRef<HTMLDivElement>(null)
  const pendingFocus = React.useRef<string | null>(null)
  const mounted = React.useRef(false)

  const live = React.useMemo(() => validateForm(form, { complete: false }), [form])
  const answers = live.answers
  const progress = progressOf(answers)
  const dirty = answersFingerprint(answers) !== savedPrint
  const isOwner = seed.role === "owner"
  const revising = seed.baselineRevision !== null

  // Warn before leaving with answers that are only on this screen.
  React.useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])

  // Move focus to the new page heading (not on first paint) and to a question the owner jumped to.
  React.useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    const key = pendingFocus.current
    pendingFocus.current = null
    if (key) {
      const el = document.getElementById(`q-${key}`)
      el?.scrollIntoView({ block: "center" })
      el?.querySelector<HTMLElement>("input, textarea, button")?.focus()
      return
    }
    headingRef.current?.focus()
  }, [phase, page])

  const setField = (key: string, next: FieldState | undefined) => {
    setForm((f) => {
      const copy = { ...f }
      if (next === undefined) delete copy[key]
      else copy[key] = next
      return copy
    })
    setServerIssues((s) => s.filter((i) => i.key !== key))
    if (status.kind === "saved" || status.kind === "error") setStatus({ kind: "idle" })
  }

  const allIssues = [...live.issues, ...serverIssues]
  const errors = showErrors ? issuesByKey(allIssues) : {}
  const shownIssues = showErrors ? allIssues : []

  const showSummary = React.useCallback(() => {
    setShowErrors(true)
    requestAnimationFrame(() => summaryRef.current?.focus())
  }, [])

  /** Writes the draft through the existing action. Returns true only when the server confirmed it (or there was nothing to write). */
  async function persist(a: Record<string, unknown>, managerDraft = false): Promise<boolean> {
    if (busy.current) return false
    const print = answersFingerprint(a)
    if (print === savedPrint) return true
    if (!Object.keys(a).length && draftVersion === null) return true
    busy.current = true
    setStatus({ kind: "saving" })
    try {
      const r = await saveBaselineDraft({ answers: a, expectedDraftVersion: draftVersion })
      if (r.ok) {
        setDraftVersion(r.data.draftVersion)
        setSavedPrint(print)
        setStatus({ kind: "saved", at: timeNow(), managerDraft })
        return true
      }
      if (r.code === "conflict") setStatus({ kind: "conflict" })
      else if (r.code === "forbidden") onForbidden()
      else if (r.code === "invalid") {
        setServerIssues(r.issues ?? [])
        setStatus({ kind: "error" })
        showSummary()
      } else setStatus({ kind: "error" })
      return false
    } catch {
      setStatus({ kind: "error" })
      return false
    } finally {
      busy.current = false
    }
  }

  async function checkAndSave(): Promise<boolean> {
    if (live.issues.length) {
      showSummary()
      return false
    }
    setShowErrors(false)
    return persist(answers)
  }

  async function next() {
    if (phase !== "quiz") return
    if (!(await checkAndSave())) return
    if (page + 1 >= PAGES) setPhase("review")
    else setPage(page + 1)
  }

  function back() {
    if (phase === "review") {
      setPhase("quiz")
      setPage(PAGES - 1)
    } else if (page > 0) setPage(page - 1)
    else if (revising && onCancel) onCancel()
    else setPhase("intro")
  }

  async function saveLater() {
    if (await checkAndSave()) onFinishLater()
  }

  function jumpTo(key: string) {
    const step = stepOfQuestion(key)
    if (!step) return
    pendingFocus.current = key
    setPhase("quiz")
    setPage(QUIZ_STEPS.indexOf(step))
  }

  async function submit() {
    if (submitting) return
    const full = validateForm(form, { complete: true })
    if (full.issues.length) {
      setServerIssues(full.issues)
      showSummary()
      return
    }
    setShowErrors(false)
    if (!isOwner) {
      // A delegated manager drafts; only the owner submits (the database enforces this too).
      if (await persist(full.answers, true)) setStatus({ kind: "saved", at: timeNow(), managerDraft: true })
      return
    }
    setSubmitting(true)
    try {
      // A draft that differs from the screen is saved first, so the submit's draft version matches the server.
      let version = draftVersion
      if (answersFingerprint(full.answers) !== savedPrint) {
        if (busy.current) return
        busy.current = true
        setStatus({ kind: "saving" })
        try {
          const saved = await saveBaselineDraft({ answers: full.answers, expectedDraftVersion: draftVersion })
          if (!saved.ok) {
            if (saved.code === "conflict") setStatus({ kind: "conflict" })
            else if (saved.code === "forbidden") onForbidden()
            else setStatus({ kind: "error" })
            return
          }
          version = saved.data.draftVersion
          setDraftVersion(version)
          setSavedPrint(answersFingerprint(full.answers))
        } finally {
          busy.current = false
        }
      }
      const r = await submitBaselineAssessment({ answers: full.answers, expectedBaseline: seed.baselineRevision, expectedDraftVersion: version })
      if (r.ok) {
        setStatus({ kind: "idle" })
        onSubmitted(r.data.revision)
      } else if (r.code === "conflict") setStatus({ kind: "conflict" })
      else if (r.code === "forbidden") onForbidden()
      else if (r.code === "invalid") {
        setServerIssues(r.issues ?? [])
        setStatus({ kind: "error" })
        showSummary()
      } else setStatus({ kind: "error" })
    } catch {
      setStatus({ kind: "error" })
    } finally {
      setSubmitting(false)
    }
  }

  const step = QUIZ_STEPS[Math.min(page, PAGES - 1)]
  const pageNumber = phase === "review" ? PAGES + 1 : page + 1

  return (
    <div className="grid gap-6" data-phase={phase}>
      {phase === "intro" ? (
        <Intro
          draft={Boolean(seed.draft)}
          mode={mode}
          onStart={() => {
            const next = initialPlace(answers, "quiz", Boolean(seed.draft))
            setPage(next.page)
            setPhase(next.phase)
          }}
          onSkip={onSkip}
          onBackStep={onBackStep}
          headingRef={headingRef}
        />
      ) : (
        <>
          <Progress
            pageNumber={pageNumber}
            total={PAGES + 1}
            title={phase === "review" ? T.reviewTitle : step.title}
            done={progress.answeredRequired}
            required={progress.required}
          />
          {status.kind === "conflict" ? <ConflictNotice onReload={onReload} /> : null}
          {shownIssues.length ? <ErrorSummary ref={summaryRef} issues={shownIssues} onGo={jumpTo} /> : null}

          {phase === "quiz" ? (
            <form
              noValidate
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                void next()
              }}
            >
              <div className="space-y-1">
                <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight text-foreground outline-none">
                  {step.title}
                </h2>
                <p className="text-sm text-muted-foreground">{step.blurb}</p>
                {page === 0 ? <p className="text-xs text-muted-foreground">{T.periodNote}</p> : null}
              </div>
              {questionsInStep(step).map((q) => (
                <QuestionField
                  key={q.key}
                  question={q}
                  field={form[q.key]}
                  onChange={(f) => setField(q.key, f)}
                  errorCode={errors[q.key]}
                  disabled={status.kind === "saving"}
                />
              ))}
              <SaveStatus status={status} dirty={dirty} />
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button type="button" variant="ghost" className="min-h-11 gap-2" onClick={back}>
                    <ArrowLeft className="size-4" aria-hidden />
                    {T.back}
                  </Button>
                  <Button type="button" variant="outline" className="min-h-11" onClick={() => void saveLater()} disabled={status.kind === "saving"}>
                    {T.saveLater}
                  </Button>
                </div>
                <Button type="submit" className="min-h-11 gap-2" disabled={status.kind === "saving"}>
                  {status.kind === "saving" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                  {page + 1 >= PAGES ? T.review : T.next}
                  <ArrowRight className="size-4" aria-hidden />
                </Button>
              </div>
            </form>
          ) : (
            <Review
              form={answers}
              role={seed.role}
              baselineRevision={seed.baselineRevision}
              submitting={submitting}
              status={status}
              dirty={dirty}
              headingRef={headingRef}
              onEdit={(key) => jumpTo(key)}
              onBack={back}
              onSubmit={() => void submit()}
            />
          )}
        </>
      )}
    </div>
  )
}

function Intro({
  draft,
  mode,
  onStart,
  onSkip,
  onBackStep,
  headingRef,
}: {
  draft: boolean
  mode: "page" | "wizard"
  onStart: () => void
  onSkip?: () => void
  onBackStep?: () => void
  headingRef: React.RefObject<HTMLHeadingElement | null>
}) {
  return (
    <div className="grid gap-5">
      <div className="space-y-2">
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight text-foreground outline-none">
          {T.title}
        </h2>
        <p className="max-w-prose text-sm text-foreground">{T.intro}</p>
      </div>
      <ul className="grid max-w-prose gap-2 text-sm text-muted-foreground">
        <li>{T.effort}</li>
        <li>{T.notAScore}</li>
        <li>{T.notAsked}</li>
        <li>{T.saveNote}</li>
      </ul>
      {draft ? <p className="rounded-md bg-muted/40 px-4 py-3 text-sm text-foreground ring-1 ring-border">{T.introDraft}</p> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button type="button" className="min-h-11 gap-2" onClick={onStart}>
          {draft ? T.resume : T.start}
          <ArrowRight className="size-4" aria-hidden />
        </Button>
        {mode === "wizard" && onSkip ? (
          <Button type="button" variant="outline" className="min-h-11" onClick={onSkip}>
            {T.skip}
          </Button>
        ) : null}
        {mode === "wizard" && onBackStep ? (
          <Button type="button" variant="ghost" className="min-h-11 gap-2" onClick={onBackStep}>
            <ArrowLeft className="size-4" aria-hidden />
            {T.back}
          </Button>
        ) : null}
      </div>
      {mode === "wizard" ? <p className="text-xs text-muted-foreground">{T.skipNote}</p> : null}
    </div>
  )
}

function Progress({ pageNumber, total, title, done, required }: { pageNumber: number; total: number; title: string; done: number; required: number }) {
  const pct = required ? Math.round((done / required) * 100) : 0
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="label-eyebrow text-muted-foreground">
          {T.stepOf(pageNumber, total)} <span aria-hidden>·</span> {title}
        </p>
        <p className="font-data text-xs text-muted-foreground">{T.answered(done, required)}</p>
      </div>
      <div
        role="progressbar"
        aria-label="Questions answered"
        aria-valuemin={0}
        aria-valuemax={required}
        aria-valuenow={done}
        aria-valuetext={T.answered(done, required)}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary transition-[width] duration-(--duration-fast)" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

const ErrorSummary = React.forwardRef<HTMLDivElement, { issues: Issue[]; onGo: (key: string) => void }>(function ErrorSummary({ issues, onGo }, ref) {
  const unique = issues.filter((i, idx) => issues.findIndex((j) => j.key === i.key) === idx)
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="rounded-md bg-status-danger-bg px-4 py-3 text-sm text-status-danger-fg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="size-4 shrink-0" aria-hidden />
        {T.errorSummary(unique.length)}
      </p>
      <ul className="mt-2 grid gap-1">
        {unique.map((i) => (
          <li key={i.key}>
            <button
              type="button"
              className="min-h-9 rounded-sm text-left underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={() => onGo(i.key)}
            >
              {QUESTION_COPY[i.key]?.label ?? i.key}
            </button>
            <span className="block text-xs">{issueMessage(i.code)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
})

function ConflictNotice({ onReload }: { onReload: () => void }) {
  return (
    <div role="alert" className="rounded-md bg-status-warning-bg px-4 py-3 text-sm text-status-warning-fg">
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="size-4 shrink-0" aria-hidden />
        {T.conflictTitle}
      </p>
      <p className="mt-1">{T.conflictBody}</p>
      <Button type="button" variant="outline" className="mt-3 min-h-11" onClick={onReload}>
        {T.conflictAction}
      </Button>
    </div>
  )
}

/** Says only what is true: "Saved" appears only after the server confirmed it. */
function SaveStatus({ status, dirty }: { status: Status; dirty: boolean }) {
  let text: string | null = null
  if (status.kind === "saving") text = T.saving
  else if (status.kind === "saved") text = status.managerDraft ? `${T.managerSaved} ${T.savedAt(status.at)}` : T.savedAt(status.at)
  else if (status.kind === "error") text = T.saveFailed
  else if (dirty) text = T.unsaved
  return (
    <p role="status" aria-live="polite" className={cn("min-h-5 text-xs", status.kind === "error" ? "font-medium text-status-danger-fg" : "text-muted-foreground")}>
      {text}
    </p>
  )
}

function Review({
  form,
  role,
  baselineRevision,
  submitting,
  status,
  dirty,
  headingRef,
  onEdit,
  onBack,
  onSubmit,
}: {
  form: Record<string, unknown>
  role: "owner" | "manager"
  baselineRevision: number | null
  submitting: boolean
  status: Status
  dirty: boolean
  headingRef: React.RefObject<HTMLHeadingElement | null>
  onEdit: (key: string) => void
  onBack: () => void
  onSubmit: () => void
}) {
  const missing = missingRequired(form)
  const isOwner = role === "owner"
  return (
    <div className="grid gap-5">
      <div className="space-y-1">
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight text-foreground outline-none">
          {T.reviewTitle}
        </h2>
        <p className="text-sm text-muted-foreground">{T.reviewBlurb}</p>
        {missing.length ? (
          <p className="flex items-center gap-2 text-sm font-medium text-status-warning-fg">
            <CircleDashed className="size-4 shrink-0" aria-hidden />
            {T.reviewMissing(missing.length)}
          </p>
        ) : null}
      </div>

      {QUIZ_STEPS.map((s) => (
        <section key={s.id} aria-labelledby={`review-${s.id}`} className="rounded-md bg-card p-4 ring-1 ring-border sm:p-5">
          <h3 id={`review-${s.id}`} className="text-sm font-semibold text-foreground">
            {s.title}
          </h3>
          <dl className="mt-3 grid gap-3">
            {questionsInStep(s).map((q) => {
              const a = form[q.key]
              const blank = a === undefined
              return (
                <div key={q.key} className="grid gap-1 sm:grid-cols-[1fr_auto] sm:gap-4">
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{QUESTION_COPY[q.key].label}</dt>
                    <dd className={cn("text-sm", blank && !q.optional ? "font-medium text-status-warning-fg" : "text-foreground")}>
                      {blank ? (q.optional ? "Skipped (optional)" : T.reviewBlank) : describeAnswer(q.key, a)}
                    </dd>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11 justify-self-start sm:justify-self-end"
                    onClick={() => onEdit(q.key)}
                    aria-label={`${T.reviewEdit}: ${QUESTION_COPY[q.key].label}`}
                  >
                    {T.reviewEdit}
                  </Button>
                </div>
              )
            })}
          </dl>
        </section>
      ))}

      <p className="max-w-prose text-sm text-muted-foreground">
        {isOwner ? (baselineRevision ? T.submitRevision(baselineRevision + 1, baselineRevision) : T.submitFirst) : T.managerNote}
      </p>
      <SaveStatus status={status} dirty={dirty} />
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="ghost" className="min-h-11 gap-2" onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden />
          {T.back}
        </Button>
        <Button type="button" className="min-h-11 gap-2" disabled={submitting || status.kind === "saving"} onClick={onSubmit}>
          {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {submitting ? T.submitting : isOwner ? T.submit : T.saveDraftForOwner}
        </Button>
      </div>
    </div>
  )
}
