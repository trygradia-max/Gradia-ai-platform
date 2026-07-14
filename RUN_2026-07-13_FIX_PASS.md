# Run queue — post-deploy fix pass (agent lookup, honest errors, CRM polish)

_Work queue for Claude Code. Discipline as prior runs: top to bottom, gates green after every item (suite/lint/tsc/build), dated section in OVERNIGHT_REPORT.md, STOP at end._

## Hard rails
- **Branching changed:** main now contains everything (PR #3, `df23c9b`). Start from fresh: `git checkout main && git pull && git checkout -b fix/post-deploy-1`. Push the branch; open a PR into main; DO NOT merge — founder merges.
- Eval fixtures FIRST for item 1. No prompt-only fixes for behavior that belongs in code (locked principle #2).
- No prod/DB actions. All locked CLAUDE.md principles apply.
- Context: first real-usage session on prod found these. Screenshots/verbatims in the founder's words: agent could not find lead "mike" (present on pipeline with phone), replied "memory search isn't pulling anyone up… might be a connection issue."

## Queue

### 1. P0 — deterministic person lookup for Ask Gradia / planner tools
The chat agent resolves people via vector memory only; leads with no interaction history are invisible to it. Fix in code:
- New/extended tool: `find_person(query)` — deterministic SQL first: ILIKE name match + E.164-normalized phone fragment across BOTH `leads` and `customers` (shop-scoped), joined with vehicle info; vector memory as a secondary signal, never the only path.
- 0 hits → honest miss ("I don't see anyone named Mike in the CRM yet — want me to create the lead?"). 1 hit → proceed. >1 → disambiguate with facts on file ("Two Mikes — the F-150 or the Civic?"). NEVER ask the owner for a phone number when a unique name match exists.
- Eval fixtures FIRST: seeded state with lead-only mike (no interactions), customer-only match, two-mikes collision, zero-match. Golden transcripts assert lookup + disambiguation + honest-miss copy.

### 2. P0 — honest failure copy audit
"Might be a connection issue" was fabricated — the query simply had no hits. Sweep runtime/planner/BI error paths: no invented infrastructure excuses anywhere. A miss says it's a miss; a real tool error says "that lookup failed on our side." Glass-box: decisions recorded, never invented. Add a source-scan test for the banned-excuse patterns where feasible.

### 3. P1 — pipeline board polish vs spec §C2 acceptance (read BUILD_REFERENCE.md first)
- Stage-age indicator actually visible (amber/red border past next_action_at) — founder's board showed 32-day-old NEW cards with no urgency signal.
- Column headers: real count + $ total styling (the bare `0`/`$90` glyphs read unfinished); empty-column microcopy per UX spec (owner-actionable, no dead ends).
- Card affordances: grab cursor, hover state, visible phone/note truncation rules; consistent vehicle line format ("'19 F-150 — white").
- New-lead modal: autofocus, Enter-to-save, opens with phone keyboard pattern on mobile.

### 4. P1 — Today/Home coherence with C6/C8 live
30-day-old untouched NEW leads produced zero Whisper suggestions and an empty "receptionist got done" panel — the page answered nothing. Either the revival candidate rule catches stale NEW leads (extend: lead in `new` >14d with contact info → revival candidate, staged) or the suggestion queue's empty state explains what it's waiting for + the one action that arms it (complete setup / connect a channel). No silent emptiness.

### 5. P2 — test-data hygiene
- `seed:smoke` rows get a `demo` tag/flag.
- Settings → Developer: "Clear demo data" action for a shop (deletes flagged rows only, confirmation dialog). Founder currently stares at "James Bond — Aston Martian — cool car" from May tests on his production pipeline.

### 6. Wrap
Gates green. Report section: what shipped + founder actions (merge the PR, redeploy, then re-run the mike test verbatim). STOP.
