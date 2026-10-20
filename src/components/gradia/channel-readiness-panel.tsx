import Link from "next/link"
import type { ChannelReadinessResult } from "@/app/actions/channel-readiness"
import { readinessStatusLabel, type ChannelKey } from "@/lib/channel-readiness"

const names: Record<ChannelKey, string> = { calls: "Calls", texting: "Texting", email: "Email", meta: "Meta lead ads" }
const links: Record<ChannelKey, string> = { calls: "/settings#voice", texting: "/settings#sms", email: "/settings#email", meta: "/settings" }

/** Setup evidence, not a claim that a provider is active or a message delivered. */
export function ChannelReadinessPanel({ result, channels = ["calls", "texting", "email", "meta"] }: {
  result: ChannelReadinessResult
  channels?: ChannelKey[]
}) {
  if (!result.ok) return <p role="alert" className="text-sm text-status-danger-fg">{result.error}</p>
  return <section aria-label="Channel setup" className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-2">
      {channels.map(key => {
        const channel = result.channels[key]
        const label = channel.state === "ready" ? "Setup checks passed" : readinessStatusLabel(channel) ?? "Unavailable"
        return <article data-channel={key} key={key} className="min-w-0 rounded-lg border border-border bg-card p-4">
          <h3 className="font-medium">{names[key]}</h3>
          <p className="mt-1 text-sm font-medium">{label}</p>
          <p className="mt-2 text-sm text-muted-foreground">{channel.message}</p>
          {key !== "meta" ? <Link href={links[key]} className="mt-2 inline-flex min-h-11 items-center text-sm underline">Manage {names[key].toLowerCase()}</Link> : null}
        </article>
      })}
    </div>
    <p className="text-xs text-muted-foreground">These are setup checks, not delivery confirmation. Channel controls, consent and approval rules still apply.</p>
  </section>
}
