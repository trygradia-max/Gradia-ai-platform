import Link from "next/link"
import { ArrowUpRight } from "lucide-react"

import { SITE } from "@/lib/site"
import { Logo } from "@/components/logo"
import { RuleX } from "@/components/textures"

const COLUMNS: { heading: string; links: { label: string; href: string }[] }[] =
  [
    {
      heading: "Product",
      links: [
        { label: "How it works", href: "/#how" },
        { label: "The agents", href: "/#agents" },
        { label: "Pricing", href: "/pricing" },
        { label: "Whisper", href: "/docs/agents/billing" },
      ],
    },
    {
      heading: "Resources",
      links: [
        { label: "Docs", href: "/docs" },
        { label: "Blog", href: "/blog" },
        { label: "Heat Score", href: "/docs/heat-score" },
        { label: "Human-in-the-loop", href: "/docs/human-in-the-loop" },
      ],
    },
    {
      heading: "Company",
      links: [
        { label: "Start free", href: SITE.appUrl },
        { label: "Sign in", href: SITE.appUrl },
      ],
    },
  ]

export function SiteFooter() {
  return (
    <footer className="relative mt-32 border-t border-border/50 bg-background">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
        <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="space-y-4">
            <Logo />
            <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
              The AI office for auto detailers. One brain across voice, email,
              SMS, and DMs — with you approving every move.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.heading} className="space-y-3.5">
              <p className="label-eyebrow text-muted-foreground/60">
                {col.heading}
              </p>
              <ul className="space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      data-cursor="cta"
                      className="group inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {l.label}
                      {l.href.startsWith("http") && (
                        <ArrowUpRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <RuleX className="my-10" />

        <div className="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            {SITE.domain} — built for working detail shops.
          </p>
          <p>© {new Date().getFullYear()} Gradia. All rights reserved.</p>
        </div>
      </div>
    </footer>
  )
}
