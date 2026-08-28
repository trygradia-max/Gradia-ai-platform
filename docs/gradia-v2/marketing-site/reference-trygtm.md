# Design Reference — trygtm.com (founder-designated, 2026-08-28)

_The founder wants Gradia's site to feel like https://trygtm.com (GTM — AI outbound-sales agents). Analyzed 2026-08-28 (hero screenshot + full content scrape). This refines site-v2-plan §5; it does not override D-033 copy or the claim discipline._

## What their site actually does (observed)

**Visual language (hero, verified by screenshot):** very light gray/off-white page · floating **dark charcoal pill nav** (fully rounded, white CTA pill inside) · small uppercase **eyebrow chip** with hairline border · **enormous near-black headline, tight tracking, two beats separated by periods** ("One prompt. Booked calls.") · centered composition · gray supporting copy, 3 short lines · **ink-dark pill primary CTA with arrow** · secondary CTA is a plain **underlined text link** ("Watch the 40-second demo") · below the fold: a large **dark rounded product frame** holding the real app · essentially **monochrome** — color appears only inside product UI.

**Structure (scraped):** Hero → "The Motion" (Find → Write → Send → Book, told through ONE concrete example) → agent roster → pricing (3 tiers, add-ons priced) → 3 personas → comparison table (them vs. traditional) → **honest FAQ** (including unflattering answers: "Can Instagram do cold outreach? No").

**Tone:** direct, confident, specific examples over generic claims, transparent about limits.

## ADOPT (mapped to our system)

1. **Centered hero** — chip eyebrow, D-033 headline (already period-beat style: "Run your shop. Capture every lead. Recover more revenue."), ≤3 short support lines, ink pill CTA + underlined-text secondary, then a large dark product frame (our `--sv-graphite`) holding Gradia UI. Amends site-v2-plan §3.1 (alignment was unspecified).
2. **Monochrome-dominant control system** — primary buttons become **ink pills** (`--sv-ink`), not violet. Violet demotes to *signal color only*: links, focus rings, selection, approval/action highlights inside product UI. This is the biggest change from Pass 1 as built. (Token/primitives updated 2026-08-28.)
3. **Eyebrow chip** — bordered pill variant of `Eyebrow` for hero/major sections.
4. **Underlined-text secondary CTA** — `Button variant="link"`; drop boxed secondary buttons in hero contexts.
5. **Dark product frames** — all product-UI compositions sit in graphite rounded frames on the light page (the §3.4 dashboard, §3.5 panels, §3.6 agent demo).
6. **One concrete example carrying a whole section** — their "Northwind opened the second follow-up" = our Sarah Mitchell thread through the connected flow. Already planned; keep it specific like theirs.
7. **Honest FAQ section** — added to the homepage before the final CTA (now section 9 of 10). Answers include the unflattering ones (e.g. "Does Gradia send messages by itself? Only if you turn autonomy on — and money and calendar always ask."). Feeds the FAQPage JSON-LD already planned in Pass 5/6.
8. **Comparison table** — "running it yourself across six tools vs. Gradia" — Product page (Pass 5), not homepage.

## DO NOT copy

- Their **dark pill nav** verbatim — it's their signature. Ours: on scroll, the nav condenses into a **floating rounded container** but stays light-surface with hairline border (our own take on the same move).
- Their tone verbatim, their agent-roster framing (Gradia's 7-agent cast is retired — do not resurrect it as a roster page), their waitlist CTA (ours is trial), or any concrete example we can't back with real product behavior.
- Fully-autonomous framing. GTM sells "agents run everything after one approval." Gradia's differentiator is the opposite — control-first. The *aesthetic* transfers; the *promise* must not.

## Builder note

Claude Code: use Playwright MCP to screenshot https://trygtm.com yourself (full scroll) as a living visual reference before Pass 2 sections 1–2. Reference for feel — every claim and copy line still comes from WHAT_GRADIA_DOES.
