import Link from "next/link"
import { CheckCircle2, CircleDashed, ClipboardList, TriangleAlert } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import { StatusPill } from "@/components/ui/status-pill"
import type { StartingPointDto } from "@/lib/onboarding-baseline/dto"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"

const T = STRINGS.pages.startingPoint
export const STARTING_POINT_HREF = "/starting-point"

/**
 * The one entry point to the Starting point from Home, Settings and the Agents home. It reads a server DTO
 * and links to the canonical `/starting-point` route; it never fetches, never invents a state, and says so
 * when the status can't be read. An account without access (`forbidden`) is shown nothing.
 */
export function StartingPointStatusCard({
  dto,
  className,
  headingLevel = 3,
}: {
  dto: StartingPointDto
  className?: string
  headingLevel?: 2 | 3
}) {
  if (dto.status === "forbidden") return null
  const Heading = headingLevel === 2 ? "h2" : "h3"

  let title: string
  let body: string
  let cta: string
  let pill: { tone: "good" | "warn" | "muted"; label: string; icon: React.ReactNode }
  if (dto.status === "ready") {
    title = T.homeReady(dto.revision)
    body = T.homeReadyBody
    cta = T.open
    pill = { tone: "good", label: "Saved", icon: <CheckCircle2 className="size-3" aria-hidden /> }
  } else if (dto.status === "not_started" && dto.draft) {
    title = T.homeDraft
    body = T.homeDraftBody
    cta = T.resume
    pill = { tone: "warn", label: "In progress", icon: <CircleDashed className="size-3" aria-hidden /> }
  } else if (dto.status === "not_started") {
    title = T.homeNotStarted
    body = T.homeNotStartedBody
    cta = T.start
    pill = { tone: "muted", label: "Not started", icon: <CircleDashed className="size-3" aria-hidden /> }
  } else {
    title = T.homeUnavailable
    body = T.homeUnavailableBody
    cta = T.open
    pill = { tone: "warn", label: "Unavailable", icon: <TriangleAlert className="size-3" aria-hidden /> }
  }

  return (
    <section aria-labelledby="starting-point-card-title" className={cn("flex flex-wrap items-center justify-between gap-4 rounded-md bg-card px-4 py-4 ring-1 ring-border sm:px-5", className)}>
      <div className="flex min-w-0 items-start gap-3">
        <ClipboardList className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Heading id="starting-point-card-title" className="text-sm font-medium text-foreground">
              {title}
            </Heading>
            <StatusPill tone={pill.tone} size="default" icon={pill.icon}>
              {pill.label}
            </StatusPill>
          </div>
          <p className="text-xs text-muted-foreground">{body}</p>
        </div>
      </div>
      <Link
        href={STARTING_POINT_HREF}
        className={cn(buttonVariants({ variant: dto.status === "ready" ? "outline" : "default" }), "min-h-11")}
      >
        {cta}
      </Link>
    </section>
  )
}

/** The Agent OS notice: a plain pointer, shown only while no starting point exists. */
export function StartingPointAgentsNotice({ dto }: { dto: StartingPointDto }) {
  if (dto.status !== "not_started") return null
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/40 px-4 py-3 text-sm text-foreground ring-1 ring-border">
      <span>{T.agentsNotice}</span>
      <Link href={STARTING_POINT_HREF} className="min-h-6 font-medium text-accent-text underline underline-offset-4">
        {T.agentsNoticeCta}
      </Link>
    </p>
  )
}
