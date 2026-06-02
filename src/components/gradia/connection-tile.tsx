import Link from "next/link"
import { Check, type LucideIcon } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The Connections screen tile (BUILD_REFERENCE §4). One integration, status as
 * icon + text. Three states: not connected (coral Connect), connected (✓ +
 * identity + Manage), and "setup needed" when the integration isn't wired on
 * the server. The popup-OAuth `connecting` state is a follow-up.
 */
export function ConnectionTile({
  icon: Icon,
  name,
  description,
  connected,
  available = true,
  connectedLabel,
  connectedDetail,
  connectHref,
  manageHref,
}: {
  icon: LucideIcon
  name: string
  description: string
  connected: boolean
  available?: boolean
  connectedLabel?: string | null
  connectedDetail?: string | null
  connectHref?: string
  manageHref?: string
}) {
  const connectedLine =
    [connectedLabel, connectedDetail].filter(Boolean).join(" · ") || description

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border/60 bg-card/40 p-5 transition-colors hover:border-border">
      <div className="flex items-start justify-between gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60 text-foreground">
          <Icon className="size-5" aria-hidden />
        </div>
        {connected ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <Check className="size-3.5" aria-hidden /> Connected
          </span>
        ) : null}
      </div>

      <div className="space-y-1">
        <p className="font-medium text-foreground">{name}</p>
        <p className="text-sm text-muted-foreground">
          {connected ? connectedLine : description}
        </p>
      </div>

      <div className="mt-auto pt-1">
        {!available ? (
          <span className="text-xs text-muted-foreground/70">
            Setup needed on the server
          </span>
        ) : connected ? (
          manageHref ? (
            <Link
              href={manageHref}
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Manage
            </Link>
          ) : null
        ) : connectHref ? (
          <Link
            href={connectHref}
            className={cn(buttonVariants({ size: "sm" }), "gap-2")}
          >
            Connect
          </Link>
        ) : null}
      </div>
    </div>
  )
}
