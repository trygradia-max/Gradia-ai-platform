# Flow — CRM Import

_Created 2026-07-25 by the Organizer. Grounded in the recovery pipeline (audit doc 00/03: mbox/CSV/vCard/structured-CSV parse → LLM extract → dedupe → review → approve with undo → retention) and D-022 (staging, mapping, preview, validation, error reporting, rollback)._

**Maturity:** PARTIAL — recovery import pipeline is built behind `FEATURES.customerRecovery` (off) and never live-smoked (GO_LIVE_CHECKLIST §4 NEXT-3). Target = D-022 full standard incl. field-mapping UI and rollback, plus CRM-specific importers (Jobber, Housecall Pro export formats).
**Phase/Epic:** E03 / P3 (trial-time import per D-005/D-006).

## Entry point
`/customers/recovery` (Customers → import entry link), or the target onboarding/trial import step.

## User objective
Bring real customers, vehicles, and history from a previous CRM, inbox, or contacts file into Gradia — safely, reviewably, reversibly.

## Required data
A source file (.mbox, contacts .csv/.vcf, or structured CRM CSV export ≤60MB); for target CRM importers: the source system's export or connected OAuth account.

## Exact steps
1. Upload file → source type validated, staged to private `recovery-imports` bucket (`import_jobs` row).
2. Parse → candidate rows staged in `import_messages` (nothing touches live tables).
3. **(TARGET, D-022)** Mapping — column→field mapping UI with sensible defaults per known CRM export shapes; unmapped columns explicitly listed.
4. Credit estimate shown ("~N credits") → owner confirms before extraction runs.
5. Extraction/dedupe → candidates grouped: ready / possible duplicate / needs a look (3 conservative dedupe layers).
6. Preview/review queue — owner inspects, edits, excludes rows; error report downloadable as CSV.
7. Approve (bulk or per-row) → customers land with `source=import`, timeline note recorded, CRM seam push if connected. Undo available.
8. Retention — raw bodies purged post-extraction (retention cron).
9. **(TARGET)** Rollback — one action reverses an entire import job (removes imported rows not since edited; edited rows flagged for manual review).

## System decisions
- Staging-first: no live-table writes before explicit approval (D-022).
- Dedupe is conservative; ambiguity goes to the review queue, never auto-merged.
- TCPA gate: customers with >18-month last transaction are never SMS-targetable by win-back (email only); `do_not_contact` respected everywhere.
- Credit pre-check fails closed.

## AI involvement
Suggest-HITL: LLM extraction proposes candidates only; nothing enters the CRM without owner approval. No outbound is staged by an import.

## Permissions
Owner today. Post-E01: admin-level members may import; rollback restricted to owner/admin.

## Error states
- Unsupported/oversized file → named error before upload completes.
- Parse failure → per-row errors in the error report; job continues with valid rows.
- Extraction failure mid-job → job resumable; failed rows listed, never silently dropped.
- Storage/credit failure → fail closed with written explanation.

## Empty states
- No import yet: "Nothing imported yet. Bring your customers over from a spreadsheet, your inbox, or your old CRM."
- Review queue empty after filter: offer Clear filters.

## Success state
"N customers added · M skipped as duplicates · K need a look" — figures traced to real rows; imported customers visible in `/customers`.

## Next recommended action
Review the "needs a look" group; then connect calendar or draft a win-back (staged for approval).

## Mobile behavior
Upload + review queue usable on a phone; mapping UI collapses to per-column cards; bulk actions via sticky action bar.

## Analytics events
`Import started` (job created after confirm), `Import completed` (approval finished), `First customer created` (if the import creates the shop's first customer).
