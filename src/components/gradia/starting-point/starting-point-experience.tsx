"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { CheckCircle2 } from "lucide-react"

import { getBaselineStartingPoint } from "@/app/actions/onboarding-baseline"
import { ErrorState } from "@/components/gradia/error-state"
import { StartingPointQuiz, type QuizSeed } from "@/components/gradia/starting-point/starting-point-quiz"
import { StartingPointReport } from "@/components/gradia/starting-point/starting-point-report"
import { Button, buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { StartingPointDto } from "@/lib/onboarding-baseline/dto"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"

const T = STRINGS.pages.startingPoint

/**
 * One container for the Starting point, used by the standalone page and by the onboarding wizard step, so
 * there is exactly one implementation of loading, error, permission-denied, not-started, in-progress,
 * already-completed and update states. It consumes the server DTO only: it never chooses a shop, role or
 * period (the session-derived actions do), and a failed read is always a written state, never an empty or
 * zero report.
 */
export function StartingPointExperience({
  initial,
  mode,
  startInQuiz = false,
  onDone,
  onSkip,
  onBackStep,
}: {
  /** The DTO the server already read. Omit it to load on mount (the wizard, where the shop is created on this very screen). */
  initial?: StartingPointDto
  mode: "page" | "wizard"
  /** Open directly in the update flow (`/starting-point?revise=1`). */
  startInQuiz?: boolean
  /** Wizard only: continue to the next setup step. */
  onDone?: () => void
  /** Wizard only: continue without a starting point. */
  onSkip?: () => void
  /** Wizard only: return to the previous setup step (the business profile). */
  onBackStep?: () => void
}) {
  const router = useRouter()
  const [dto, setDto] = React.useState<StartingPointDto | null>(initial ?? null)
  const [loading, setLoading] = React.useState(false)
  const [editing, setEditing] = React.useState(startInQuiz)
  const [quizKey, setQuizKey] = React.useState(0)
  const [saved, setSaved] = React.useState<number | null>(null)
  const [denied, setDenied] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      setDto(await getBaselineStartingPoint())
    } catch {
      setDto({ status: "unavailable" })
    } finally {
      setLoading(false)
    }
  }, [])

  // First load (wizard only): the answer arrives asynchronously, so state is set from the promise, not the effect body.
  React.useEffect(() => {
    if (initial) return
    let live = true
    getBaselineStartingPoint().then(
      (r) => live && setDto(r),
      () => live && setDto({ status: "unavailable" })
    )
    return () => {
      live = false
    }
  }, [initial])

  if (denied || dto?.status === "forbidden") {
    return (
      <div className="flex justify-center py-8">
        <ErrorState
          title={T.forbiddenTitle}
          description={T.forbiddenBody}
          action={
            mode === "wizard" && onSkip ? (
              <Button type="button" variant="outline" className="min-h-11" onClick={onSkip}>
                {T.skip}
              </Button>
            ) : (
              <Link href="/dashboard" className={cn(buttonVariants({ variant: "outline" }), "min-h-11")}>
                {T.backHome}
              </Link>
            )
          }
        />
      </div>
    )
  }

  if (dto === null || loading) {
    return (
      <div role="status" aria-busy="true" aria-label={T.loadingLabel} className="grid gap-4">
        <span className="sr-only">{T.loadingLabel}</span>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (dto.status === "unavailable") {
    return (
      <div className="flex justify-center py-8">
        <ErrorState
          title={T.unavailableTitle}
          description={T.unavailableBody}
          action={
            <>
              <Button type="button" className="min-h-11" onClick={() => void load()}>
                {T.retry}
              </Button>
              {mode === "wizard" && onSkip ? (
                <Button type="button" variant="outline" className="min-h-11" onClick={onSkip}>
                  {T.skip}
                </Button>
              ) : null}
            </>
          }
        />
      </div>
    )
  }

  const reload = async () => {
    await load()
    setQuizKey((k) => k + 1)
  }
  const afterSubmit = async (revision: number) => {
    setSaved(revision)
    setEditing(false)
    await load()
    if (mode === "page") {
      router.replace("/starting-point")
      router.refresh()
    }
  }
  const finishLater = () => (mode === "wizard" && onSkip ? onSkip() : router.push("/dashboard"))

  const quiz = (seed: QuizSeed, startAt: "intro" | "quiz") => (
    <StartingPointQuiz
      key={quizKey}
      seed={seed}
      mode={mode}
      startAt={startAt}
      onReload={() => void reload()}
      onSubmitted={(r) => void afterSubmit(r)}
      onFinishLater={finishLater}
      onSkip={onSkip}
      onBackStep={onBackStep}
      onCancel={() => setEditing(false)}
      onForbidden={() => setDenied(true)}
    />
  )

  if (dto.status === "not_started") {
    return quiz({ role: dto.role, baselineRevision: null, draft: dto.draft, revisionAnswers: null }, startInQuiz || editing ? "quiz" : "intro")
  }

  // status === "ready"
  if (editing) {
    return quiz({ role: dto.role, baselineRevision: dto.revision, draft: dto.draft, revisionAnswers: dto.answers }, "quiz")
  }

  const banner =
    saved !== null ? (
      <p role="status" className="flex items-center gap-2 rounded-md bg-status-success-bg px-4 py-3 text-sm font-medium text-status-success-fg">
        <CheckCircle2 className="size-4 shrink-0" aria-hidden />
        {T.submitted(saved)}
      </p>
    ) : null

  const actions = (
    <>
      <Button type="button" className="min-h-11" onClick={() => setEditing(true)}>
        {T.update}
      </Button>
      <p className="text-xs text-muted-foreground">{T.updateNote}</p>
    </>
  )

  if (mode === "wizard") {
    return (
      <div className="grid gap-5">
        {banner}
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">{T.completedTitle}</h2>
          <p className="text-sm text-muted-foreground">{T.completedBody(dto.revision)}</p>
        </div>
        <details className="rounded-md bg-muted/30 p-4 ring-1 ring-border">
          <summary className="min-h-11 cursor-pointer text-sm font-medium text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            {T.reportTitle}
          </summary>
          <div className="pt-4">
            <StartingPointReport dto={dto} />
          </div>
        </details>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button type="button" className="min-h-11" onClick={onDone}>
            {T.continueSetup}
          </Button>
          <Button type="button" variant="outline" className="min-h-11" onClick={() => setEditing(true)}>
            {T.update}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-5">
      {banner}
      {dto.draft ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/40 px-4 py-3 ring-1 ring-border">
          <p className="text-sm text-foreground">{T.draftBanner}</p>
          <Button type="button" variant="outline" className="min-h-11" onClick={() => setEditing(true)}>
            {T.draftContinue}
          </Button>
        </div>
      ) : null}
      <StartingPointReport dto={dto} actions={actions} />
    </div>
  )
}
