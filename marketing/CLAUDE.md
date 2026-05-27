# Gradia Marketing Site — Build Spec

This is a **standalone Next.js 16 app** living in `/marketing`. It is isolated from
the product app (`/src`). It re-declares the Gradia design tokens locally — it must
**never** import from the app's `@/*` alias.

**Quality bar:** the app's `/how-it-works` page. Match or exceed it on every page.
**Tone:** premium, confident, built for professionals. Speak to detailers as expert
tradespeople — Stripe-to-developers level of respect and clarity. Gradia speaks as
*we/us*, never *you and I*.

---

## ANIMATION STANDARDS — non-negotiable

- **Every section** fades/slides in on scroll via framer-motion (`RevealOnScroll` +
  `RevealItem`). Default: `opacity 0→1`, `y 24→0`, `EASE_OUT_EXPO`, `once: true`.
- **Staggered children** on all feature grids and lists (`staggerChildren: 0.08`).
- **Hero entrance sequence** on mount: logo → headline → sub → CTA, each delayed
  ~100ms apart (`PageStagger` with explicit per-child delays).
- **Lenis** drives global smooth scroll (`SmoothScroll` provider in root layout).
- **Hover states on every interactive element** — scale, glow, or border reveal.
  Cards lift (`y: -4, scale: 1.005`, spring); CTAs get `accent-glow`.
- **Page transitions** between routes (`AnimatePresence` + template/transition wrapper).
- Always honor `prefers-reduced-motion` — disable transforms, keep content visible.

## VISUAL STANDARDS

- `grain-layer` overlay on the hero and every dark section. Always.
- `mesh-hero` background on the homepage hero (and reused on section anchors).
- `glass-card` for any floating UI element (nav, approval-card mockups, badges).
- `accent-glow` on primary CTAs.
- **No flat solid backgrounds** — always depth: gradient, mesh, or grain.
- **Generous whitespace** — let content breathe (section spacing `space-y-24`+).

## TYPOGRAPHY

- **Instrument Serif** for all headlines — large and commanding (`.font-display`).
- **`clamp()` for all font sizes** — fluid, never static. Use the `--text-*` tokens
  and inline `clamp()` for hero/section heads.
- **`label-eyebrow`** micro-label before every section headline.
- Body: **Geist**. Mono: **Geist Mono**.

## THE $30K DETAILS (things AI sites skip — we don't)

- **Horizontal scroll section** for the feature/agent showcase.
- **Pinned scroll storytelling** — a section that stays put while its content animates
  through steps (the "how a lead flows" sequence).
- **Number counters** that animate up when scrolled into view (`Counter`).
- **Smooth anchor navigation** with scroll offset (Lenis `scrollTo` + nav offset).
- **Loading screen** on first visit (sessionStorage-gated, fades out).
- **Custom cursor** that reacts when hovering CTAs (grows / accent ring).

---

## DESIGN TOKENS (ported from app `globals.css` — keep in sync)

- Surfaces: `--background: oklch(0.06 0 0)` true black, `--card: oklch(0.10 0 0)`.
- Accent / primary: **racing orange** `oklch(0.72 0.18 35)` (~#FF6A3D).
- Fonts: `--font-display: Instrument Serif`, `--font-sans: Geist`, mono: Geist Mono.
- Easing: `--ease-out-expo: cubic-bezier(0.22, 1, 0.36, 1)`.
- Utilities available: `.font-display`, `.label-eyebrow`, `.text-hero`,
  `.grain-layer`, `.mesh-hero`, `.glass-card`, `.accent-glow`.

## PRODUCT FACTS (ground all copy in these — from the real codebase)

- **What it is:** an agentic AI office for auto detailers. Not a chatbot. One brain,
  shared memory, across voice / email / SMS / DMs. Human-in-the-loop on everything
  outbound (Approve / Edit / Reject in Slack).
- **Price:** $20/month per user. Bring-your-own integrations. No invented tiers.
- **The 7 core agents** (source: `src/lib/data/agents.ts`):
  1. Voice receptionist (Vapi) 2. Email assistant (Gmail/Aurinko)
  3. SMS assistant (Twilio) 4. Instagram DM agent (Meta)
  5. Booking agent (Google Calendar + Twilio + cron)
  6. Billing agent (Stripe Connect + Gradia Whisper voice-to-invoice)
  7. Memory & insights (pgvector RAG + Ask Gradia BI chat)
- **Also:** custom agent builder (schedule/event triggers), co-owner proactive nudges,
  transparent **Heat Score** lead heuristic (NOT black-box ML — be honest about it).

## STRUCTURE

```
/marketing
  app/            homepage, pricing, docs/*, blog/*, layout, transitions
  components/     marketing UI (nav, footer, hero, motion primitives, cursor, loader)
  content/blog/   MDX posts
  assets/
    videos/       Higgsfield hero video (.mp4)
    images/       Higgsfield feature/explainer stills
  lib/            utils (cn), site config
```

## DO NOT

- Import from `@/*` (app source). This site is self-contained.
- Invent pricing tiers. One real plan + a tasteful "scale / talk to us" panel.
- Fake product UI in generated imagery — build UI mockups in real CSS instead.
- Ship a flat background or a static (non-clamp) headline size.
