# Gradia Component Sourcing Map

Where every UI component comes from and where it goes in the repo. Companion to `GRADIA-REDESIGN-SPEC.md`. Research verified against 21st.dev, shadcn docs, and vendor sites on July 2, 2026.

> **⚠️ AMENDED by `GRADIA-REDESIGN-SPEC.md` §8-A7 (2026-07-02):** shadcn is **already installed** (style `base-nova` — the fresh-init/Rhea assumption below is superseded); destination paths map to the repo's existing `src/components/gradia/` + `src/components/ui/`; **21st.dev membership skipped** (existing ~78 components cover the map); **Recharts approved** for Tremor copy-paste at Layer 3; the Radix/@base-ui dual stack is **frozen** — no new Base UI components. The one absolute rule below (retoken before commit, import only at the layer that uses it) stands unchanged.

## The one rule that keeps this from becoming Frankenstein UI

**No component ships with its own colors, fonts, or spacing.** Everything pulled from 21st.dev or anywhere else gets adapted to Gradia's tokens (spec §2) before commit. Pulling pretty components from five sites and pasting them as-is is how apps end up looking worse than before the redesign — the token sweep in Layer 1 exists precisely so imports have one system to conform to. Fortunately, 21st.dev components are shadcn-registry format (Tailwind + CSS variables) by requirement, so retokening is usually a variable-mapping exercise, not a rewrite.

## Stack decision

**Base: shadcn/ui** (`npx shadcn@latest init`, MIT, Radix-based). It's the substrate 21st.dev components are built on, so one install path covers both. Use the **Rhea** style as the starting preset — shadcn's own "denser surfaces, built for focused product interfaces" style (shipped May 2026), which matches the instrument-panel direction.

**How third-party components install** (current syntax, verified):
- From 21st.dev: `npx shadcn@latest add "https://21st.dev/r/<author>/<component>"`
- From any public GitHub repo with a root `registry.json`: `npx shadcn@latest add <user>/<repo>/<item>` (new June 2026)
- Named registries configurable in `components.json` → then `npx shadcn@latest add @registry/button`

**21st.dev practical notes:**
- Signed-in free tier = **2 component copies/day** (since June 2026). Membership $8/mo removes the cap and unlocks registry installs. Budget for one month of membership during the redesign session; it pays for itself in the first hour.
- Their **MCP server** works with Claude Code: free Inspiration Search + SVG icon search, and "Magic Generate" ($20/mo Pro) that generates variants in-browser. Optional — useful for browsing, not required for installs.
- Only pull **featured** components (human-reviewed tier); below that, quality is community-variable.
- License caveat (flagged, unverified): community components are widely reported MIT but 21st.dev has no explicit site-wide license statement — check the component page before shipping anything.

## Component → source → destination

Destination paths assume a `src/components/` root; Claude Code maps them to the repo's actual structure in Layer 0.

| Component | Source | Install/notes | Goes to | Used by (layer) |
|---|---|---|---|---|
| Button, Input, Select, Textarea, Checkbox, Switch, Dialog, DropdownMenu, Tooltip, Tabs, Toast (sonner), Skeleton | **shadcn/ui core** | `npx shadcn@latest add button input select ...` | `components/ui/` | Layer 1 primitives — everything |
| Badge (status variants) | shadcn base, extend with `--status-*` token variants | success/warning/danger/info + `-bg` companions | `components/ui/badge.tsx` | Outcome badges everywhere |
| Sidebar (collapsible, sections, badge slots) | **shadcn Sidebar** first; browse 21st.dev "sidebars" category only if it can't do shop-switcher + collapse + count badges | shadcn's sidebar is mature; don't import a stranger's when the base one fits | `components/shell/sidebar.tsx` | Layer 2 shell |
| Top bar / header | Build from primitives (it's a flex row: title, search, credits pill, help) | Don't import a "header component" for 40 lines of layout | `components/shell/topbar.tsx` | Layer 2 shell |
| Command palette (Cmd+K) | **shadcn Command** (cmdk) | Power-user layer, never the only path | `components/shell/command-menu.tsx` | Layer 2, optional |
| KPI cards with sparklines | **Tremor** (copy-paste versions, NOT the npm package — package is maintenance-mode since the Vercel acquisition) | Free/open source since Jan 2025; strongest KPI-card + spark-chart vocabulary available | `components/dashboard/kpi-card.tsx` | Layer 3 dashboard |
| Charts (usage, call volume) | **Tremor** copy-paste or shadcn `Chart` (both Recharts-based — pick ONE, don't mix chart stacks) | Recommend Tremor for KPI/spark, shadcn Chart if you want fewer sources | `components/dashboard/` | Layer 3 |
| Data table (conversations, customers) | **shadcn Table + TanStack Table** pattern; 21st.dev "tables" category for a featured variant with row-density toggle if base lacks it | Density toggle is a spec requirement | `components/ui/data-table.tsx` | Layer 3 conversations/customers |
| Activity feed / timeline | 21st.dev "timelines"/"feeds" category for structure inspiration; expect to **build** — the "because" line, outcome badge, AI/human flag layout is Gradia-specific | This is your differentiator; nobody sells it pre-made | `components/glassbox/activity-feed.tsx` | Layer 4 |
| Transcript + audio player | 21st.dev audio-player components exist; check featured tier; otherwise build on `<audio>` + primitives | Waveform is nice-to-have, not required | `components/glassbox/call-record.tsx` | Layer 4 |
| Approval queue cards (Approve / Edit & approve / Dismiss) | Build from primitives | Three-button HITL card is Gradia-specific | `components/glassbox/review-queue.tsx` | Layer 4 |
| Chat/message bubbles (SMS threads) | **shadcn chat components** (June 2026: Message, Bubble, MessageScroller, Attachment) | Purpose-built, same stack | `components/conversations/` | Layer 3 |
| Empty states | shadcn base + spec §4 copy rules; Aceternity ONLY if you want one delight illustration | Keep motion out of daily-use surfaces | `components/ui/empty-state.tsx` | All layers |
| Nudge/upsell card | Build from primitives per `GRADIA-LANGUAGE-PACK.md` §4 | Dismissal persistence + frequency caps are logic, not a component you can buy | `components/nudges/nudge-card.tsx` | Layer 3/4 |
| Marketing site sections (hero, pricing, footer) | **Aceternity UI** / 21st.dev marketing categories | **Out of scope for this session** (spec §6). Noted here so it doesn't sneak into the app shell — Framer Motion landing flair does not belong in a dashboard |Separate marketing repo/pass | Not this session |

**On "footer":** dashboards don't have marketing footers. In-app, the footer is the sidebar's pinned bottom section (Numbers & Billing, Settings — spec §3). A page footer with link columns belongs to the marketing site pass, where Aceternity/21st.dev marketing sections are the right source.

## Sources not chosen, and why

- **Origin UI** → now "coss ui" (Cal.com's design system), rebuilt on Base UI, not Radix. Mixing Base UI and Radix means two headless stacks — skip unless a specific particle is irreplaceable.
- **Untitled UI React** → polished but React Aria-based (again, a second stack), own CLI, and its component license is separate from its MIT CLI. Not worth the friction when shadcn + 21st.dev + Tremor covers the map.
- **Aceternity for app UI** → animation-heavy, landing-page oriented. Marketing pass only.

## Order of operations in the session

Layer 1 installs shadcn core + retokens; component imports from 21st.dev/Tremor happen **at the layer that needs them** (KPI cards in Layer 3, not upfront), each immediately retokened and committed. Never import a batch of components speculatively — every import must land in a screen the same layer it enters the repo.
