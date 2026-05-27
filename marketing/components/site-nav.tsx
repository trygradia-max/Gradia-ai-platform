"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { ArrowRight, Menu, X } from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"

import { NAV, SITE } from "@/lib/site"
import { cn } from "@/lib/utils"
import { Logo } from "@/components/logo"
import { buttonVariants } from "@/components/ui/button"
import { scrollToHash } from "@/components/smooth-scroll"

export function SiteNav() {
  const pathname = usePathname()
  const router = useRouter()
  const [scrolled, setScrolled] = React.useState(false)
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  // Smooth-scroll same-page anchors through Lenis; otherwise navigate.
  const handleNav = (href: string) => (e: React.MouseEvent) => {
    setOpen(false)
    if (href.startsWith("/#")) {
      const hash = href.slice(1)
      if (pathname === "/") {
        e.preventDefault()
        scrollToHash(hash)
      } else {
        e.preventDefault()
        router.push(href)
      }
    }
  }

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        scrolled
          ? "border-b border-border/50 bg-background/70 backdrop-blur-xl"
          : "border-b border-transparent"
      )}
    >
      <nav className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-3.5 sm:px-8">
        <Link
          href="/"
          data-cursor="cta"
          className="rounded-full px-1 transition-opacity hover:opacity-80"
          aria-label="Gradia home"
        >
          <Logo />
        </Link>

        <div className="hidden items-center gap-1 md:flex">
          {NAV.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={handleNav(link.href)}
              data-cursor="cta"
              className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Link
            href={SITE.appUrl}
            data-cursor="cta"
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "hidden sm:inline-flex"
            )}
          >
            Sign in
          </Link>
          <Link
            href={SITE.appUrl}
            data-cursor="cta"
            className={cn(buttonVariants({ size: "sm" }), "hidden sm:inline-flex")}
          >
            Start free
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
          <button
            onClick={() => setOpen((v) => !v)}
            className="inline-flex size-9 items-center justify-center rounded-lg border border-border/60 bg-card/50 text-foreground md:hidden"
            aria-label="Toggle menu"
            aria-expanded={open}
          >
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </nav>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden border-t border-border/50 bg-background/95 backdrop-blur-xl md:hidden"
          >
            <div className="flex flex-col gap-1 px-5 py-4">
              {NAV.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={handleNav(link.href)}
                  className="rounded-lg px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
                >
                  {link.label}
                </Link>
              ))}
              <Link
                href={SITE.appUrl}
                className={cn(buttonVariants({ size: "lg" }), "mt-2 w-full")}
              >
                Start free
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  )
}
