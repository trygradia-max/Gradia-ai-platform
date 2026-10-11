import type { ReactNode } from "react"

import { SkipLink } from "@/components/gradia/skip-link"
import { cn } from "@/lib/utils"

/**
 * Team pages keep their own chrome (staff may have no owner desk). They
 * still get the same skip link and main landmark as AppShell.
 */
export function TeamChrome({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <>
      <SkipLink href="#main-content">Skip to main content</SkipLink>
      <main
        id="main-content"
        tabIndex={-1}
        className={cn(
          "mx-auto min-h-screen max-w-3xl space-y-8 p-6 outline-none",
          className
        )}
      >
        {children}
      </main>
    </>
  )
}
