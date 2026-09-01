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
