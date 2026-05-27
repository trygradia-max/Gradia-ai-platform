import * as React from "react"
import Link from "next/link"
import { ArrowLeft, ArrowRight, Info } from "lucide-react"

import { docNeighbors } from "@/lib/docs"
import { cn } from "@/lib/utils"
import { RevealOnScroll, RevealItem } from "@/components/motion/reveal"

export function DocHeader({
  eyebrow,
  title,
  intro,
}: {
  eyebrow: string
  title: string
  intro: string
}) {
  return (
    <RevealOnScroll className="space-y-4 border-b border-border/50 pb-8">
      <RevealItem>
        <p className="label-eyebrow text-primary">{eyebrow}</p>
      </RevealItem>
      <RevealItem>
        <h1 className="font-display text-[clamp(2rem,5vw,3.25rem)] leading-[1.05] tracking-[-0.03em] text-foreground">
          {title}
        </h1>
      </RevealItem>
      <RevealItem>
        <p className="max-w-2xl text-lg leading-relaxed text-muted-foreground">
          {intro}
        </p>
      </RevealItem>
    </RevealOnScroll>
  )
}

/** Branded long-form container — mirrors the MDX prose styling. */
export function DocProse({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-10 space-y-5 text-[15px] leading-[1.75] text-muted-foreground [&_h2]:mt-12 [&_h2]:mb-3 [&_h2]:font-display [&_h2]:text-[clamp(1.4rem,3vw,2rem)] [&_h2]:leading-tight [&_h2]:tracking-[-0.02em] [&_h2]:text-foreground [&_h3]:mt-8 [&_h3]:mb-2 [&_h3]:font-display [&_h3]:text-xl [&_h3]:text-foreground [&_strong]:font-semibold [&_strong]:text-foreground">
      {children}
    </div>
  )
}

export function Callout({
  title = "Good to know",
  children,
}: {
  title?: string
  children: React.ReactNode
}) {
  return (
    <div className="glass-card my-7 flex gap-3 rounded-2xl p-5">
      <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <div className="text-sm leading-relaxed text-muted-foreground">
          {children}
        </div>
      </div>
    </div>
  )
}

/** Checklist of capabilities, styled like the homepage feature lists. */
export function CheckList({ items }: { items: string[] }) {
  return (
    <ul className="my-6 grid gap-2.5 sm:grid-cols-2">
      {items.map((item) => (
        <li
          key={item}
          className="flex items-start gap-2.5 rounded-xl border border-border/50 bg-card/40 px-4 py-3 text-sm text-foreground/85"
        >
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/70" />
          {item}
        </li>
      ))}
    </ul>
  )
}

export function DocPager({ href }: { href: string }) {
  const { prev, next } = docNeighbors(href)
  return (
    <div className="mt-16 grid gap-3 border-t border-border/50 pt-8 sm:grid-cols-2">
      {prev ? (
        <Link
          href={prev.href}
          data-cursor="cta"
          className="group flex flex-col gap-1 rounded-2xl border border-border/60 bg-card/40 p-5 transition-colors hover:border-border hover:bg-card"
        >
          <span className="label-eyebrow flex items-center gap-1.5 text-muted-foreground/60">
            <ArrowLeft className="size-3" /> Previous
          </span>
          <span className="font-display text-lg text-foreground">
            {prev.title}
          </span>
        </Link>
      ) : (
        <span />
      )}
      {next && (
        <Link
          href={next.href}
          data-cursor="cta"
          className={cn(
            "group flex flex-col items-end gap-1 rounded-2xl border border-border/60 bg-card/40 p-5 text-right transition-colors hover:border-border hover:bg-card",
            !prev && "sm:col-start-2"
          )}
        >
          <span className="label-eyebrow flex items-center gap-1.5 text-muted-foreground/60">
            Next <ArrowRight className="size-3" />
          </span>
          <span className="font-display text-lg text-foreground">
            {next.title}
          </span>
        </Link>
      )}
    </div>
  )
}
