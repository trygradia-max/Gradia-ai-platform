"use client"

import Link from "next/link"
import { createContext, useContext, type ComponentProps, type MouseEvent } from "react"

/**
 * Unsaved-edit guard for client-side navigation. `beforeunload` only covers full page loads;
 * Next `Link` navigations bypass it, so every link that can leave the builder goes through here.
 * Outside a provider (detail page, revision page) it is a plain link.
 */
export type NavGuard = { dirty: boolean; requestLeave: (href: string) => void }
const NavGuardContext = createContext<NavGuard | null>(null)
export const NavGuardProvider = NavGuardContext.Provider

/** True when the click would open in a new tab/window or download, which never discards this page. */
export function isNewContextClick(event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "button">, target?: string | null): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0 || (target != null && target !== "" && target !== "_self")
}

export function GuardedLink({ href, onClick, target, ...rest }: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
  const guard = useContext(NavGuardContext)
  return (
    <Link
      {...rest}
      href={href}
      target={target}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        if (guard?.dirty && !isNewContextClick(event, target)) {
          event.preventDefault()
          guard.requestLeave(href)
        }
      }}
    />
  )
}
