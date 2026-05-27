import type { ComponentType } from "react"

export type Post = {
  slug: string
  title: string
  description: string
  date: string // ISO
  readingTime: string
  tag: string
  author: string
  cover: string
}

/**
 * Post metadata registry. The MDX body for each lives in
 * content/blog/<slug>.mdx and carries only content — keeping listing
 * metadata here means the index never has to parse every file.
 */
export const POSTS: Post[] = [
  {
    slug: "the-front-desk-problem",
    title: "The front desk is the most expensive seat in your shop",
    description:
      "Every call you miss while your hands are wet is a job that books somewhere else. The math on the lead you never called back — and what an always-on office actually changes.",
    date: "2026-05-12",
    readingTime: "6 min",
    tag: "Operations",
    author: "The Gradia team",
    cover: "/assets/images/feature-voice.jpg",
  },
  {
    slug: "the-follow-up-you-never-send",
    title: "Ceramic, PPF, and the follow-up you never send",
    description:
      "Your best lead is a customer you already detailed. Why high-ticket retention lives or dies on the six-month follow-up — and how to send it without becoming a marketer.",
    date: "2026-05-06",
    readingTime: "7 min",
    tag: "Retention",
    author: "The Gradia team",
    cover: "/assets/images/feature-interior.jpg",
  },
  {
    slug: "draft-never-autopilot",
    title: "Why we draft, never autopilot",
    description:
      "Full-autonomy AI is a liability in a trade where the words and the price are the product. The case for keeping a human in the loop — and why it makes the AI more useful, not less.",
    date: "2026-04-28",
    readingTime: "6 min",
    tag: "Philosophy",
    author: "The Gradia team",
    cover: "/assets/images/feature-detail.jpg",
  },
]

/**
 * Static slug → MDX loader map. Explicit (not a template-string dynamic
 * import) so both webpack and Turbopack can resolve every post at build.
 */
export const POST_CONTENT: Record<
  string,
  () => Promise<{ default: ComponentType }>
> = {
  "the-front-desk-problem": () =>
    import("@/content/blog/the-front-desk-problem.mdx"),
  "the-follow-up-you-never-send": () =>
    import("@/content/blog/the-follow-up-you-never-send.mdx"),
  "draft-never-autopilot": () =>
    import("@/content/blog/draft-never-autopilot.mdx"),
}

export function getPost(slug: string): Post | undefined {
  return POSTS.find((p) => p.slug === slug)
}

export const SORTED_POSTS = [...POSTS].sort((a, b) =>
  a.date < b.date ? 1 : -1
)

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
}
