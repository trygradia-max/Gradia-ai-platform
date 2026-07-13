import Link from "next/link"
import { Check, type LucideIcon } from "lucide-react"

import { ConnectionConnectButton } from "@/components/gradia/connection-connect-button"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The Connections screen tile (BUILD_REFERENCE §4). Server Component so it can
 * take an icon; status is icon + text. States: not connected (accent Connect —
 * popup for OAuth, link otherwise), connected (✓ + identity + Manage), and
 * "setup needed" when the integration isn't wired on the server.
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
  popup = false,
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
  popup?: boolean
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
        ) : !available ? (
          <span className="inline-flex items-center rounded-full bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground">
            Coming soon
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
          // Built but not yet wired for this workspace — a clean "Coming soon"
          // badge sits top-right; no dead-end label or fake button here.
          <span className="text-xs text-muted-foreground/70">
            We&rsquo;ll let you know the moment it&rsquo;s ready.
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
        ) : !connectHref ? null : popup ? (
          <ConnectionConnectButton href={connectHref} />
        ) : (
          <Link
            href={connectHref}
            className={cn(buttonVariants({ size: "sm" }), "gap-2")}
          >
            Connect
          </Link>
        )}
      </div>
    </div>
  )
}
