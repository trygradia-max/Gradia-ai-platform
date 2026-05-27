import type { MDXComponents } from "mdx/types"
import Link from "next/link"

/**
 * Global MDX component map. Blog posts render inside the article shell
 * (which sets the prose container), so here we only need to brand the
 * primitives — display-serif headings, accent links, glass code blocks.
 */
const components: MDXComponents = {
  h2: (props) => (
    <h2
      className="font-display mt-14 mb-4 text-[clamp(1.6rem,3.5vw,2.25rem)] leading-[1.1] tracking-[-0.02em] text-foreground"
      {...props}
    />
  ),
  h3: (props) => (
    <h3
      className="font-display mt-10 mb-3 text-[clamp(1.25rem,2.5vw,1.6rem)] leading-tight tracking-[-0.015em] text-foreground"
      {...props}
    />
  ),
  p: (props) => (
    <p className="my-5 leading-[1.75] text-muted-foreground" {...props} />
  ),
  ul: (props) => (
    <ul className="my-5 space-y-2 pl-1 text-muted-foreground" {...props} />
  ),
  ol: (props) => (
    <ol
      className="my-5 list-decimal space-y-2 pl-5 text-muted-foreground marker:text-primary/70"
      {...props}
    />
  ),
  li: (props) => (
    <li className="leading-[1.7] [ul>&]:relative [ul>&]:pl-5 [ul>&]:before:absolute [ul>&]:before:left-0 [ul>&]:before:top-3 [ul>&]:before:size-1.5 [ul>&]:before:-translate-y-1/2 [ul>&]:before:rounded-full [ul>&]:before:bg-primary/60" {...props} />
  ),
  a: ({ href = "#", ...props }) => (
    <Link
      href={href}
      className="font-medium text-primary underline decoration-primary/30 underline-offset-4 transition-colors hover:decoration-primary"
      {...props}
    />
  ),
  strong: (props) => (
    <strong className="font-semibold text-foreground" {...props} />
  ),
  blockquote: (props) => (
    <blockquote
      className="glass-card my-7 rounded-2xl border-l-2 border-l-primary/60 px-6 py-4 text-lg italic text-foreground/90"
      {...props}
    />
  ),
  code: (props) => (
    <code
      className="rounded-md bg-card px-1.5 py-0.5 font-mono text-[0.85em] text-primary ring-1 ring-border/60"
      {...props}
    />
  ),
  hr: () => (
    <hr className="my-12 border-0 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
  ),
}

export function useMDXComponents(
  inherited: MDXComponents = {}
): MDXComponents {
  return { ...inherited, ...components }
}
