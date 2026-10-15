import { SkipLink } from "@/components/gradia/skip-link"

export default function Loading() {
  return (
    <>
      <SkipLink href="#main-content">Skip to policy drafts</SkipLink>
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-3xl space-y-4 p-6 outline-none"
        aria-busy="true"
        aria-label="Loading policy drafts"
      >
        <div className="h-8 animate-pulse rounded-md bg-muted" />
        <div className="h-64 animate-pulse rounded-md bg-muted" />
      </main>
    </>
  )
}
