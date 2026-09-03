# SITE_SYNC — platform → website handoff

_Append-only. The platform autorun (Claude Code) appends one block after EVERY ticket commit. The site autorun (Cursor) reads this file at the start of every run and acts only on blocks newer than its last `SITE-READ` marker. Nothing else crosses between the two repos._

Block format (Claude Code writes):
```
## <date time> · <TICKET> · commit <hash>
- Claimable now (per WHAT_GRADIA_DOES §4/§5, D-028 status): <capability #, live|beta|planned> — or "no change"
- New/changed screens worth showing: <route> — <one line what it shows> — Vercel preview: <url or "pending founder push">
- Copy that must change on the site: <exact old → new> — or "none"
- Do NOT claim yet: <anything built but gated>
```
Marker (Cursor writes after each run):
```
### SITE-READ <date time> — consumed through commit <hash>
```

---

## 2026-09-02 · BATCH 1 (PROD-CONFIG-AUDIT · P0-005A · P0-012 · CLEANUP-001 · UX-001) + PR #34 · commit ff66cc9 (+ cdb0c99)
_Organizer-written at the batch close — the Builder wrote no per-ticket blocks (autorun rule 4); this one block covers all five tickets and the Gmail fix._
- Claimable now (per WHAT_GRADIA_DOES §4/§5, D-028 status): **no change.** Email capture stays at its current status (the Gmail connect flow now actually persists — PR #34 — but the claim was never withdrawn); voice still not claimable; Housecall Pro is gone (never claimable).
- New/changed screens worth showing: `/settings` — connection tiles now show Connected / Connect / NOT AVAILABLE truthfully with a ⓘ "what this does" line on every card; `/approvals` — ⓘ on every approval type; `/receptionist` builder — ⓘ on every field + "Going live" checklist; Housecall Pro tile and all Slack copy removed — Vercel preview: production `main` at `ff66cc9`.
- Copy that must change on the site: any mention of **Housecall Pro** or **Slack approvals** → remove (D-052); "Coming soon" phrasing for integrations → "Not available yet" only where the site mirrors app copy; otherwise none.
- Do NOT claim yet: voice receptionist / business numbers (acceptance run pending); ops alerting (founder destination not configured); three-tier pricing (P0-013 not built).

### SITE-READ 2026-09-02 16:30 PT — consumed through commit ff66cc9

### SITE-READ 2026-09-02 16:22 PT — consumed through commit ff66cc9 (no new platform blocks; Pass 6 marketing commit follows)

### SITE-READ 2026-09-02 17:25 PT — consumed through commit ff66cc9 (no new blocks)

### SITE-READ 2026-09-02 16:35 PT — consumed through commit ff66cc9 (Pass 7 QA complete)

### SITE-READ 2026-09-02 16:45 PT — consumed through commit ff66cc9 (no new blocks; /receptionist depth page built)

### SITE-READ 2026-09-02 16:27 PT — consumed through commit ff66cc9 (no new platform blocks; Passes 2–7 builder queue complete)

### SITE-READ 2026-09-02 16:31 PT — consumed through commit ff66cc9 (no new blocks; builder idle — AUTORUN Passes 2–7 complete)

### SITE-READ 2026-09-02 16:32 PT — consumed through commit ff66cc9 (no new blocks; builder idle — tsc + build verified)

### SITE-READ 2026-09-02 16:34 PT — consumed through commit ff66cc9 (no new blocks; builder idle — tsc + build verified)

## 2026-09-02 18:05 PDT · PERF-001 · commit 7a9e04d
- Claimable now (per WHAT_GRADIA_DOES §4/§5, D-028 status): no change to capabilities. Speed claim allowed only in relative terms once the Preview re-measure lands ("Home loads with a third of the round-trips it used to"); no absolute millisecond or Lighthouse numbers on the site — they were measured locally, not on Vercel.
- New/changed screens worth showing: /dashboard (recent-leads module shows the newest few with "See all N in Customers") · /customers pipeline (columns show the newest 30 with "N older — search in Customers"; totals unchanged) · /approvals (12 cards a page + "Show N more"; header keeps the true pending count) — Vercel preview: pending founder push of `auto/batch-1b`
- Copy that must change on the site: none
- Do NOT claim yet: "sub-second" / "instant" anything; a Speed Insights / Core Web Vitals badge (not enabled); the "See all"/"Show more" controls as features (they are truthful caps, not navigation)
