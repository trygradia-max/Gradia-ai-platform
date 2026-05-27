import { AGENTS } from "@/lib/site"

export type DocLink = { title: string; href: string }
export type DocSection = { title: string; links: DocLink[] }

/**
 * Docs IA — mirrors the product's real surface area. The "Agents" group is
 * generated from the same AGENTS catalog the homepage uses, so docs and
 * marketing can never drift apart.
 */
export const DOC_NAV: DocSection[] = [
  {
    title: "Getting started",
    links: [
      { title: "Overview", href: "/docs" },
      { title: "Human-in-the-loop", href: "/docs/human-in-the-loop" },
      { title: "Shared memory", href: "/docs/memory" },
    ],
  },
  {
    title: "The agents",
    links: AGENTS.map((a) => ({
      title: a.name,
      href: `/docs/agents/${a.slug}`,
    })),
  },
  {
    title: "Going further",
    links: [
      { title: "Custom agents", href: "/docs/custom-agents" },
      { title: "Heat Score", href: "/docs/heat-score" },
    ],
  },
]

/** Flattened, ordered list of every doc href — powers prev/next paging. */
export const DOC_ORDER: DocLink[] = DOC_NAV.flatMap((s) => s.links)

export function docNeighbors(href: string): {
  prev?: DocLink
  next?: DocLink
} {
  const i = DOC_ORDER.findIndex((l) => l.href === href)
  if (i === -1) return {}
  return {
    prev: i > 0 ? DOC_ORDER[i - 1] : undefined,
    next: i < DOC_ORDER.length - 1 ? DOC_ORDER[i + 1] : undefined,
  }
}
