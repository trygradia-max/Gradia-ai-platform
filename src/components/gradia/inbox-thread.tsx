import Link from "next/link"

import { StatusPill } from "@/components/ui/status-pill"
import {
  threadStateLabels,
  type WhisperThread,
} from "@/lib/whisper-inbox"
import { cn } from "@/lib/utils"

const CHANNEL = { sms: "Text", email: "Email", voice: "Call" } as const
const ROLE = { customer: "Customer", gradia: "Gradia", system: "System" } as const
const STATE_TONE = {
  needs_reply: "warn",
  awaiting_approval: "accent",
  held: "bad",
  completed: "muted",
} as const

function when(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function InboxThread({
  thread,
  shopId,
  customerId,
  page,
  base,
  controls,
}: {
  thread: WhisperThread
  shopId: string
  customerId: string
  page: number
  base: string
  controls: React.ReactNode
}) {
  const name = thread.customer.name ?? "Unnamed customer"
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border/70 px-4 py-3">
        <Link
          href={`/conversations?shop=${encodeURIComponent(shopId)}`}
          className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline lg:hidden"
        >
          Inbox
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-lg tracking-tight">{name}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {CHANNEL[thread.channel]}
            {thread.customer.phone ? ` · ${thread.customer.phone}` : ""}
            {thread.customer.email ? ` · ${thread.customer.email}` : ""}
          </p>
        </div>
        <StatusPill tone={STATE_TONE[thread.state]}>
          {threadStateLabels[thread.state]}
        </StatusPill>
        {thread.can_reply ? (
          <Link
            href={`/customers/${customerId}`}
            className="hidden text-sm underline-offset-2 hover:underline sm:inline"
          >
            Customer
          </Link>
        ) : null}
        <Link href={base} className="text-sm text-muted-foreground underline-offset-2 hover:underline">
          Refresh
        </Link>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-28 sm:pb-4">
        {thread.state === "held" ? (
          <p
            role="alert"
            className="mb-4 rounded-md border border-status-warning/30 bg-status-warning-bg px-3 py-2 text-sm text-status-warning-fg"
          >
            {thread.reason ||
              "Execution is unconfirmed. Review the approval and provider evidence. Do not send it again."}
          </p>
        ) : null}

        {thread.intakes.length ? (
          <ul className="mb-4 flex flex-col gap-1 text-xs text-muted-foreground">
            {thread.intakes.map((i) => (
              <li key={i.id}>
                <Link
                  href={`/intake/${i.id}?shop=${shopId}`}
                  className="underline underline-offset-2"
                >
                  Intake evidence
                </Link>
                {i.vehicle_id ? " · vehicle reviewed" : ""}
              </li>
            ))}
          </ul>
        ) : null}

        <ol className="flex flex-col gap-3">
          {thread.items.slice(0, 20).map((m) => (
            <li
              key={m.id}
              className={cn(
                "flex flex-col gap-1",
                m.role === "gradia" && "items-end",
                m.role === "system" && "items-center"
              )}
            >
              {m.role === "system" ? (
                <p className="max-w-md text-center text-xs text-muted-foreground">
                  {m.content}
                </p>
              ) : (
                <p
                  className={cn(
                    "max-w-[min(36rem,86%)] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm",
                    m.role === "customer"
                      ? "rounded-bl-md bg-muted text-foreground"
                      : "rounded-br-md bg-primary text-primary-foreground"
                  )}
                >
                  {m.content}
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                {ROLE[m.role]} ·{" "}
                <time dateTime={m.occurred_at} title={m.occurred_at}>
                  {when(m.occurred_at)}
                </time>
              </p>
            </li>
          ))}
        </ol>

        <nav className="mt-4 flex gap-4 text-sm" aria-label="Message pages">
          {page > 1 ? (
            <Link href={`${base}&page=${page - 1}`} className="underline underline-offset-2">
              Newer messages
            </Link>
          ) : null}
          {thread.items.length > 20 ? (
            <Link href={`${base}&page=${page + 1}`} className="underline underline-offset-2">
              Older messages
            </Link>
          ) : null}
        </nav>

        {thread.actions.length ? (
          <section className="mt-6 border-t border-border/70 pt-4">
            <h2 className="text-sm font-medium">Approvals for this thread</h2>
            <ul className="mt-2 space-y-1 text-sm">
              {thread.actions.map((a) => (
                <li key={a.id}>
                  <Link href={`/approvals/${a.id}`} className="underline underline-offset-2">
                    {a.status}
                    {a.status === "approved" && !a.result_id
                      ? " — execution unconfirmed. Review it. Do not resend."
                      : ""}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      {controls}
    </div>
  )
}
