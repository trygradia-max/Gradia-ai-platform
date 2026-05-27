import { DocsSidebar } from "@/components/docs/docs-sidebar"

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto max-w-6xl px-5 pt-28 pb-10 sm:px-8 sm:pt-32">
      <div className="grid gap-10 lg:grid-cols-[220px_1fr] lg:gap-14">
        {/* Sidebar — sticks below the nav on desktop. */}
        <aside className="lg:sticky lg:top-28 lg:h-[calc(100vh-8rem)] lg:overflow-y-auto lg:pr-2">
          <DocsSidebar />
        </aside>

        <article className="min-w-0 max-w-3xl">{children}</article>
      </div>
    </div>
  )
}
