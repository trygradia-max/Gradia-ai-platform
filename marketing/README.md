# Gradia — Marketing site

The public marketing website for Gradia (the AI office for auto detailers). A
**standalone Next.js 16 app**, fully isolated from the product app in `../src`.
It re-declares the Gradia design tokens locally and never imports from the app's
`@/*` alias.

## Run it

```bash
cd marketing
npm install
npm run dev      # http://localhost:3100
npm run build    # production build (all pages prerender static / SSG)
```

The dev/start ports are pinned to **3100** so the marketing site and the product
app (3000) can run side by side.

## Stack

Next.js 16 · React 19 · Tailwind v4 (CSS-first `@theme`) · framer-motion · Lenis
· lucide-react · MDX (`@next/mdx`).

## Structure

```
app/
  page.tsx              Homepage (hero video, agents showcase, how-it-works, …)
  pricing/              Single honest $20 plan + scale panel + FAQ
  docs/                 Sidebar shell + overview, HITL, memory, custom agents,
    agents/[slug]/      heat score, and one page per core agent (SSG)
  blog/                 MDX blog index + [slug] post renderer (SSG)
  globals.css           Design tokens ported from ../src/app/globals.css
  icon.svg              Branded favicon
components/             Nav, footer, cursor, loader, motion primitives, home/*, docs/*
content/blog/*.mdx      Seed posts
lib/                    site.ts (product facts), docs.ts (IA), blog.ts (registry), utils
assets/                 Higgsfield-generated media (canonical store)
  images/  videos/      Symlinked into public/ so they serve at /assets/*
mdx-components.tsx      Branded MDX element styling
```

## Content is data-driven

The 7 agents live once in `lib/site.ts` and feed the homepage showcase, the docs
sidebar, and the per-agent doc pages — so marketing and docs can't drift. All copy
is grounded in the real product (`../src/lib/data/agents.ts`, `PROJECT_BRIEF.md`).
Pricing is the real single $20/user plan; no invented tiers.

## Visual assets

Generated with Higgsfield (Cinema Studio 3.0 video, Nano Banana Pro stills) and
stored in `assets/`. To regenerate, replace the files in `assets/images` /
`assets/videos` — the symlink into `public/` means components keep working.

See `CLAUDE.md` for the full design + animation spec this site is built against.
