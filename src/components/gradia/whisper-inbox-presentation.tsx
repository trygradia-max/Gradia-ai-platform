import { useId, type ReactNode } from "react"
import Link from "next/link"

import { EmptyState } from "@/components/gradia/empty-state"
import { ErrorState } from "@/components/gradia/error-state"
import { Pagination } from "@/components/gradia/pagination"
import { SkipLink } from "@/components/gradia/skip-link"
import { StatusPill, type StatusPillTone } from "@/components/ui/status-pill"
import {
  threadStateLabels,
  type WhisperThread,
  threadListSchema,
} from "@/lib/whisper-inbox"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"
import type { z } from "zod"

export type WhisperThreadList = z.infer<typeof threadListSchema>
type ThreadListItem = WhisperThreadList["items"][number]

const shell =
  "relative mx-auto w-full min-w-0 max-w-3xl space-y-6 px-4 py-6 sm:px-6 lg:max-w-4xl lg:py-8"
const textLink =
  "inline-flex min-h-11 max-w-full items-center rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
const wrap = "whitespace-pre-wrap break-words"
const anywhere = { overflowWrap: "anywhere" } as const

const channelLabels = { sms: "SMS", email: "Email", voice: "Call" } as const

function stateTone(state: keyof typeof threadStateLabels): StatusPillTone {
  if (state === "needs_reply") return "warn"
  if (state === "awaiting_approval") return "accent"
  if (state === "held") return "bad"
  return "muted"
}

export function formatWhisperUtc(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "Unknown time"
  return `${date.toLocaleString("en-US", { timeZone: "UTC" })} UTC`
}

function sameInstant(left: string, right: string): boolean {
  const a = Date.parse(left)
  const b = Date.parse(right)
  if (Number.isNaN(a) || Number.isNaN(b)) return left === right
  return a === b
}

export function WhisperWorkspaceUnavailable() {
  return (
    <div className={shell}>
      <h1 className="font-display text-2xl text-foreground">Whisper conversations</h1>
      <p role="alert" className="max-w-prose text-sm">
        Conversation workspace unavailable.{" "}
        <Link href="/team" className={textLink}>
          Your workspaces
        </Link>
      </p>
    </div>
  )
}

function WorkspaceNav({
  shops,
  shopId,
}: {
  shops: { id: string; name: string }[]
  shopId: string
}) {
  return (
    <nav aria-label="Conversation workspaces">
      <ul className="flex flex-wrap gap-2">
        {shops.map((shop) => {
          const current = shop.id === shopId
          return (
            <li key={shop.id} className="max-w-full min-w-0">
              <Link
                href={`/conversations?shop=${shop.id}`}
                aria-current={current ? "page" : undefined}
                className={cn(
                  textLink,
                  "max-w-full px-2 py-1",
                  wrap,
                  current ? "bg-muted font-medium" : undefined
                )}
                style={anywhere}
              >
                {shop.name}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

function WhisperThreadCard({
  item,
  shopId,
  page,
  active,
}: {
  item: ThreadListItem
  shopId: string
  page: number
  active: boolean
}) {
  const labelId = useId()
  const detailId = useId()
  const name = item.customer_name ?? "Unnamed customer"
  return (
    <li className="min-w-0">
      <Link
        href={`/conversations/${item.customer_id}?shop=${shopId}&channel=${item.channel}${page > 1 ? `&list=${page}` : ""}`}
        aria-labelledby={labelId}
        aria-describedby={detailId}
        aria-current={active ? "page" : undefined}
        className={cn(
          "block min-w-0 rounded-md bg-card p-4 text-foreground ring-1 ring-border outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50",
          active && "bg-popover ring-2 ring-ring"
        )}
      >
        <span className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <span className="min-w-0 space-y-1">
            <span id={labelId} className={cn("block font-medium", wrap)} style={anywhere}>
              {name}
              <span className="sr-only">
                , {channelLabels[item.channel]}, {threadStateLabels[item.state]}
                {active ? ", Current conversation" : ""}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              <time dateTime={item.created_at}>
                Recorded {formatWhisperUtc(item.created_at)}
              </time>
            </span>
          </span>
          <span className="flex max-w-full flex-wrap gap-1.5">
            <StatusPill tone="muted">{channelLabels[item.channel]}</StatusPill>
            {item.notified ? <StatusPill tone="accent">New handoff</StatusPill> : null}
            {item.unread ? <StatusPill tone="warn">Unread</StatusPill> : null}
            {active ? <StatusPill tone="muted">Current</StatusPill> : null}
            <StatusPill tone={stateTone(item.state)}>
              {threadStateLabels[item.state]}
            </StatusPill>
          </span>
        </span>
        <span id={detailId} className="mt-3 block space-y-2">
          <span className={cn("block text-sm text-muted-foreground", wrap)} style={anywhere}>
            {item.preview}
          </span>
          <span className={cn("block text-sm", wrap)} style={anywhere}>
            Assignee: {item.assignee}
          </span>
        </span>
      </Link>
    </li>
  )
}

export function WhisperConversationList({
  shops,
  shopId,
  page,
  data,
  activeCustomerId,
  activeChannel,
  children,
}: {
  shops: { id: string; name: string }[]
  shopId: string
  page: number
  data: WhisperThreadList | null
  activeCustomerId?: string
  activeChannel?: string
  children?: ReactNode
}) {
  const visible = data?.items.slice(0, 20) ?? []
  const hasNext = Boolean(data && data.items.length > 20)
  const Heading = activeCustomerId ? "h2" : "h1"
  const listHref = (target: number) => {
    if (activeCustomerId && activeChannel) {
      const base = `/conversations/${activeCustomerId}?shop=${shopId}&channel=${activeChannel}`
      return target > 1 ? `${base}&list=${target}` : base
    }
    return `/conversations?shop=${shopId}&page=${target}`
  }
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col lg:overflow-y-auto">
      <div className="space-y-6 px-4 py-4 sm:px-5 sm:py-5">
      <SkipLink href="#whisper-threads">Skip to conversations</SkipLink>
      {activeCustomerId ? (
        <SkipLink href="#whisper-messages">Skip to open conversation</SkipLink>
      ) : null}
      <Link href="/team" className={textLink}>
        Your workspaces
      </Link>
      <header className="space-y-2">
        <p className="label-eyebrow text-muted-foreground">Whisper</p>
        <Heading
          id="whisper-list-title"
          tabIndex={-1}
          className="rounded-sm font-display text-2xl text-balance text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Whisper conversations
        </Heading>
        <p className="max-w-prose text-sm text-muted-foreground">
          Stored SMS, email and call history. Opening a thread does not send, mark it
          read or grant consent.
        </p>
      </header>
      <WorkspaceNav shops={shops} shopId={shopId} />
      <div id="whisper-threads" tabIndex={-1} className="scroll-mt-6 space-y-4 outline-none">
        {!data ? (
          <ErrorState
            compact
            title="Conversations could not be loaded. This is not an empty inbox."
          />
        ) : (
          <>
            <p
              className="max-w-prose text-sm text-muted-foreground"
              {...(data.notifications > 0 ? { role: "status" as const } : {})}
            >
              {data.notifications} in-app handoff notifications. Manager email
              notifications are disabled.
            </p>
            {data.unidentified > 0 ? (
              <p role="alert" className="max-w-prose rounded-md bg-status-warning-bg px-4 py-3 text-sm text-status-warning-fg">
                {data.unidentified} unidentified interactions need identity review. They
                have not been combined into one customer thread.{" "}
                <Link href={`/intake?shop=${shopId}`} className={textLink}>
                  Open intake
                </Link>
              </p>
            ) : null}
            {visible.length ? (
              <ul aria-label="Visible conversations" className="space-y-3">
                {visible.map((item) => (
                  <WhisperThreadCard
                    key={`${item.customer_id}:${item.channel}`}
                    item={item}
                    shopId={shopId}
                    page={page}
                    active={item.customer_id === activeCustomerId && item.channel === activeChannel}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState
                className="px-4 py-6"
                title={
                  page <= 1
                    ? STRINGS.empty.conversationsFirstUseTitle
                    : STRINGS.empty.conversationsPageEmpty
                }
                description={
                  page <= 1 ? STRINGS.empty.conversationsFirstUse : undefined
                }
              />
            )}
            <Pagination
              label="Conversation pages"
              status={`Page ${page}`}
              previous={page > 1 ? { href: listHref(page - 1) } : null}
              next={hasNext ? { href: listHref(page + 1) } : null}
            />
          </>
        )}
      </div>
      {children}
      </div>
    </div>
  )
}

function roleLabel(role: WhisperThread["items"][number]["role"]): string {
  if (role === "customer") return "Customer"
  if (role === "gradia") return "Gradia"
  return "System"
}

export function WhisperThreadView({
  listHref,
  refreshHref,
  page,
  thread,
  shopId,
  customerId,
  controls,
  loadError = "load",
}: {
  listHref: string
  refreshHref: string
  page: number
  thread: WhisperThread | null
  shopId: string
  customerId: string
  controls?: ReactNode
  loadError?: "access" | "load"
}) {
  const visible = thread?.items.slice(0, 20) ?? []
  const hasOlder = Boolean(thread && thread.items.length > 20)
  // The column itself scrolls only when the panes' minimum heights do not
  // fit, so a short desktop window never clips the refresh link.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:overflow-y-auto">
      <div className="relative shrink-0 space-y-3 border-b border-border px-4 py-4 sm:px-5">
      <SkipLink href="#whisper-messages">Skip to conversation</SkipLink>
      <Link href={listHref} className={textLink}>
        Back to conversations
      </Link>
      <header className="space-y-3">
        <p className="label-eyebrow text-muted-foreground">Whisper</p>
        <h1
          id="whisper-thread-title"
          tabIndex={-1}
          className={cn(
            "rounded-sm font-display text-2xl text-balance text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            wrap
          )}
          style={anywhere}
        >
          {thread?.customer.name ?? "Conversation"}
        </h1>
        {thread ? (
          <div className="flex max-w-full flex-wrap gap-1.5">
            <StatusPill tone="muted">{channelLabels[thread.channel]}</StatusPill>
            <StatusPill tone={stateTone(thread.state)}>
              {threadStateLabels[thread.state]}
            </StatusPill>
          </div>
        ) : null}
        <p className="max-w-prose text-sm text-muted-foreground">
          Opening or refreshing this page does not send, mark it read, or grant consent.
        </p>
      </header>
      </div>
      <div
        id="whisper-messages"
        tabIndex={-1}
        data-whisper-pane="messages"
        className="min-h-0 flex-1 scroll-mt-6 space-y-6 px-4 py-4 outline-none sm:px-5 lg:min-h-[14rem] lg:overflow-y-auto"
      >
      {!thread ? (
        <ErrorState
          compact
          title={loadError === "access"
            ? "Conversation unavailable. Check access and refresh."
            : "Conversation could not be loaded. Refresh to try again."}
        />
      ) : (
        <>
          {thread.state === "held" ? (
            <p role="alert" className={cn("max-w-prose rounded-md bg-status-danger-bg px-4 py-3 text-sm text-status-danger-fg", wrap)} style={anywhere}>
              {thread.reason ||
                "Execution is unconfirmed. Review approval and provider evidence; never automatically resend."}
            </p>
          ) : null}
          {thread.can_reply ? (
            <Link className={textLink} href={`/customers/${customerId}`}>
              Customer record
            </Link>
          ) : null}
          {thread.intakes.length ? (
            <section aria-labelledby="whisper-intake-heading" className="space-y-2">
              <h2 id="whisper-intake-heading" className="font-display text-lg text-foreground">
                Intake evidence
              </h2>
              <p className="text-sm text-muted-foreground">
                {thread.intakes.length} linked intake{" "}
                {thread.intakes.length === 1 ? "record" : "records"}.
              </p>
              <ul className="space-y-2">
                {thread.intakes.map((intake) => (
                  <li key={intake.id} className="min-w-0">
                    <Link className={textLink} href={`/intake/${intake.id}?shop=${shopId}`}>
                      Intake evidence and reviewed vehicle
                    </Link>
                    {intake.vehicle_id ? (
                      <p className="break-all text-sm text-muted-foreground">
                        Vehicle reference <span className="font-data">{intake.vehicle_id}</span>
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="space-y-3">
            <p className="max-w-prose text-sm text-muted-foreground">
              Newest recorded messages are first. Occurred is when the message happened.
              Recorded is shown when the stored copy arrived later.
            </p>
            {visible.length ? (
              <ol aria-label="Message history" className="space-y-3">
                {visible.map((message) => {
                  const align = message.role === "gradia" ? "justify-end" : "justify-start"
                  return (
                    <li key={message.id} className={cn("flex min-w-0", align)}>
                      <article
                        className={cn(
                          "min-w-0 space-y-2 rounded-md p-4 ring-1 ring-border",
                          message.role === "system"
                            ? "w-full max-w-full bg-muted/40"
                            : "max-w-full bg-card sm:max-w-[85%]"
                        )}
                      >
                        <header className="flex min-w-0 flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-3">
                          <p className="text-sm font-medium">{roleLabel(message.role)}</p>
                          <p className="min-w-0 text-xs text-muted-foreground">
                            <time dateTime={message.occurred_at}>
                              Occurred {formatWhisperUtc(message.occurred_at)}
                            </time>
                            {sameInstant(message.occurred_at, message.created_at) ? null : (
                              <>
                                {" "}
                                <time dateTime={message.created_at}>
                                  Recorded {formatWhisperUtc(message.created_at)}
                                </time>
                              </>
                            )}
                          </p>
                        </header>
                        <p className={cn("text-sm", wrap)} style={anywhere}>
                          {message.content}
                        </p>
                      </article>
                    </li>
                  )
                })}
              </ol>
            ) : (
              <EmptyState
                className="px-4 py-6"
                title="No messages on this page."
              />
            )}
          </div>
          <Pagination
            label="Message pages"
            status={`Page ${page}`}
            previous={
              page > 1
                ? { href: `${refreshHref}&page=${page - 1}`, label: "Newer messages" }
                : null
            }
            next={
              hasOlder
                ? { href: `${refreshHref}&page=${page + 1}`, label: "Older messages" }
                : null
            }
          />
          {page !== 1 ? (
            <p className="max-w-prose text-sm text-muted-foreground">
              Read, handoff and draft controls stay on the newest messages.
            </p>
          ) : null}
          {thread.actions.length ? (
            <section aria-labelledby="whisper-approvals-heading" className="space-y-2">
              <h2 id="whisper-approvals-heading" className="font-display text-lg text-foreground">
                Approval and execution records
              </h2>
              <ul className="space-y-2">
                {thread.actions.map((action) => (
                  <li key={action.id} className="min-w-0">
                    <Link className={cn(textLink, wrap)} style={anywhere} href={`/approvals/${action.id}`}>
                      {action.status}
                      {action.status === "approved" && !action.result_id
                        ? " — execution unconfirmed; review, do not resend"
                        : ""}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
      </div>
      {/* Capped so the message history keeps at least 14rem on a 900px
          laptop window; the controls scroll inside their own pane. */}
      {controls ? (
        <div
          data-whisper-pane="controls"
          className="shrink-0 border-t border-border lg:max-h-[min(38%,30rem)] lg:overflow-y-auto"
        >
          {controls}
        </div>
      ) : null}
      <div className="shrink-0 px-4 py-3 sm:px-5">
        <Link href={refreshHref} className={textLink}>
          Refresh conversation
        </Link>
      </div>
    </div>
  )
}
