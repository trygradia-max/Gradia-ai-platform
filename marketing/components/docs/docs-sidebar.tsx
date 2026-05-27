"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { DOC_NAV } from "@/lib/docs"
import { cn } from "@/lib/utils"

export function DocsSidebar() {
  const pathname = usePathname()
  return (
    <nav className="space-y-7">
      {DOC_NAV.map((section) => (
        <div key={section.title}>
          <p className="label-eyebrow mb-2.5 text-muted-foreground/50">
            {section.title}
          </p>
          <ul className="space-y-0.5">
            {section.links.map((link) => {
              const active = pathname === link.href
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    data-cursor="cta"
                    className={cn(
                      "relative block rounded-lg px-3 py-1.5 text-sm transition-colors",
                      active
                        ? "bg-primary/10 font-medium text-foreground"
                        : "text-muted-foreground hover:bg-card hover:text-foreground"
                    )}
                  >
                    {active && (
                      <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />
                    )}
                    {link.title}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
