import Link from "next/link"
import {
  ArrowUpRight,
  AtSign,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Circle,
  CreditCard,
  Globe,
  Mail,
  MessageSquare,
  Phone,
} from "lucide-react"

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { ChannelId, ChannelSummary } from "@/lib/data/channels"

const ICONS: Record<ChannelId, typeof Phone> = {
  voice: Phone,
  email: Mail,
  sms: MessageSquare,
  calendar: CalendarDays,
  payments: CreditCard,
  instagram: AtSign,
  facebook: Globe,
}

export function ChannelConnectionCard({
  channels,
}: {
  channels: ChannelSummary[]
}) {
  const connected = channels.filter((c) => c.status === "connected").length
  const total = channels.length

  return (
    <Card className="border-border/80">
      <CardHeader className="space-y-1 pb-3">
        <CardTitle className="text-base font-medium">
          Channels
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          What we&apos;re plugged into right now —{" "}
          <span className="font-medium text-foreground">
            {connected} of {total} live.
          </span>{" "}
          The rest are a paste-and-save away.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 sm:grid-cols-2">
          {channels.map((c) => (
            <li key={c.id}>
              <Link
                href={c.href}
                className="group flex items-start gap-3 rounded-md border border-border/60 bg-muted/10 px-3 py-2.5 transition hover:bg-muted/30"
              >
                <ChannelIcon channel={c} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium">
                      {c.label}
                    </p>
                    <StatusPill status={c.status} />
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {c.hint ?? c.description}
                  </p>
                </div>
                <ArrowUpRight
                  className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100"
                  aria-hidden
                />
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function ChannelIcon({ channel }: { channel: ChannelSummary }) {
  const Icon = ICONS[channel.id]
  const className =
    channel.status === "connected"
      ? "text-emerald-600 dark:text-emerald-400"
      : channel.status === "partial"
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground"
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background">
      <Icon className={`size-4 ${className}`} aria-hidden />
    </div>
  )
}

function StatusPill({ status }: { status: ChannelSummary["status"] }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="size-3" aria-hidden />
        Live
      </span>
    )
  }
  if (status === "partial") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
        <CircleAlert className="size-3" aria-hidden />
        Needs info
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      <Circle className="size-3" aria-hidden />
      Off
    </span>
  )
}
