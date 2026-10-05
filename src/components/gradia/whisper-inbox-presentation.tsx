import { useId, type ReactNode } from "react"
import Link from "next/link"

import { StatusPill, type StatusPillTone } from "@/components/ui/status-pill"
import {
  threadStateLabels,
  type WhisperThread,
  threadListSchema,
} from "@/lib/whisper-inbox"
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

function SkipLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      className="absolute -left-[10000px] h-px w-px overflow-hidden rounded-sm bg-background px-3 text-sm focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:h-auto focus:w-auto focus:overflow-visible focus:py-2 focus:ring-3 focus:ring-ring/50"
    >
      {children}
    </a>
  )
}

export function WhisperWorkspaceUnavailable() {
  return (
    <main className={shell}>
      <h1 className="font-display text-2xl text-foreground">Whisper conversations</h1>
      <p role="alert" className="max-w-prose text-sm">
        Conversation workspace unavailable.{" "}
        <Link href="/team" className={textLink}>
          Your workspaces
        </Link>
      </p>
    </main>
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
}: {
  item: ThreadListItem
  shopId: string
}) {
  const labelId = useId()
  const detailId = useId()
  const name = item.customer_name ?? "Unnamed customer"
  return (
    <li className="min-w-0">
      <Link
        href={`/conversations/${item.customer_id}?shop=${shopId}&channel=${item.channel}`}
        aria-labelledby={labelId}
        aria-describedby={detailId}
        className="block min-w-0 rounded-md bg-card p-4 text-foreground ring-1 ring-foreground/10 outline-none hover:bg-muted/30 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <span className="min-w-0 space-y-1">
            <span id={labelId} className={cn("block font-medium", wrap)} style={anywhere}>
              {name}
              <span className="sr-only">
                , {channelLabels[item.channel]}, {threadStateLabels[item.state]}
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
  children,
}: {
  shops: { id: string; name: string }[]
  shopId: string
  page: number
  data: WhisperThreadList | null
  children?: ReactNode
}) {
  const visible = data?.items.slice(0, 20) ?? []
  const hasNext = Boolean(data && data.items.length > 20)
  return (
    <main className={shell}>
      <SkipLink href="#whisper-threads">Skip to conversations</SkipLink>
      <Link href="/team" className={textLink}>
        Your workspaces
      </Link>
      <header className="space-y-2">
        <p className="label-eyebrow text-muted-foreground/70">Whisper</p>
        <h1 className="font-display text-2xl text-balance text-foreground">
          Whisper conversations
        </h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Stored SMS, email and call history. Opening a thread does not send, mark it
          read or grant consent.
        </p>
      </header>
      <WorkspaceNav shops={shops} shopId={shopId} />
      <div id="whisper-threads" tabIndex={-1} className="scroll-mt-6 space-y-4 outline-none">
        {!data ? (
          <p role="alert" className="max-w-prose rounded-md bg-status-danger-bg px-4 py-3 text-sm text-status-danger-fg">
            Conversations could not be loaded. This is not an empty inbox.
          </p>
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
                  <WhisperThreadCard key={`${item.customer_id}:${item.channel}`} item={item} shopId={shopId} />
                ))}
              </ul>
            ) : (
              <p className="rounded-md bg-muted/40 px-4 py-6 text-sm text-muted-foreground">
                No visible conversations on this page.
              </p>
            )}
            <nav aria-label="Conversation pages" className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <p className="text-sm text-muted-foreground">Page {page}</p>
              {page > 1 ? (
                <Link className={textLink} href={`/conversations?shop=${shopId}&page=${page - 1}`}>
                  Previous
                </Link>
              ) : null}
              {hasNext ? (
                <Link className={textLink} href={`/conversations?shop=${shopId}&page=${page + 1}`}>
                  Next
                </Link>
              ) : null}
            </nav>
          </>
        )}
      </div>
      {children}
    </main>
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
}: {
  listHref: string
  refreshHref: string
  page: number
  thread: WhisperThread | null
  shopId: string
  customerId: string
  controls?: ReactNode
}) {
  const visible = thread?.items.slice(0, 20) ?? []
  const hasOlder = Boolean(thread && thread.items.length > 20)
  return (
    <main className={shell}>
      <SkipLink href="#whisper-messages">Skip to conversation</SkipLink>
      <Link href={listHref} className={textLink}>
        Back to conversations
      </Link>
      <header className="space-y-3">
        <p className="label-eyebrow text-muted-foreground/70">Whisper</p>
        <h1 className={cn("font-display text-2xl text-balance text-foreground", wrap)} style={anywhere}>
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
      <div id="whisper-messages" tabIndex={-1} className="scroll-mt-6 space-y-6 outline-none">
      {!thread ? (
        <p role="alert" className="max-w-prose rounded-md bg-status-danger-bg px-4 py-3 text-sm text-status-danger-fg">
          Conversation unavailable. Check access and refresh.
        </p>
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
                          "min-w-0 space-y-2 rounded-md p-4 ring-1 ring-foreground/10",
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
              <p className="rounded-md bg-muted/40 px-4 py-6 text-sm text-muted-foreground">
                No messages on this page.
              </p>
            )}
          </div>
          <nav aria-label="Message pages" className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="text-sm text-muted-foreground">Page {page}</p>
            {page > 1 ? (
              <Link className={textLink} href={`${refreshHref}&page=${page - 1}`}>
                Newer messages
              </Link>
            ) : null}
            {hasOlder ? (
              <Link className={textLink} href={`${refreshHref}&page=${page + 1}`}>
                Older messages
              </Link>
            ) : null}
          </nav>
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
          {controls}
        </>
      )}
      </div>
      <Link href={refreshHref} className={textLink}>
        Refresh conversation
      </Link>
    </main>
  )
}
