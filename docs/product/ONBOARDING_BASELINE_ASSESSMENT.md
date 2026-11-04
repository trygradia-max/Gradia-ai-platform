# Gradia onboarding baseline assessment

_Founder-approved product addition: 2026-11-04. This specification adds a
versioned starting-point assessment to onboarding. It does not authorize a shared
database migration, production write unfreeze, analytics tracking or deployment._

## Purpose

Gradia should know where a shop starts before claiming that it improved anything.
The assessment captures a small, understandable operational baseline, distinguishes
owner estimates from connected evidence, and creates the comparison point for the
first 30-day pilot review.

It is not a personality quiz, a lead-scoring form or an arbitrary “efficiency
score.” Gradia shows the underlying measures and their confidence instead of
compressing unlike numbers into false precision.

## Onboarding placement

Add **Starting point** after the required shop profile and before service/menu and
connector setup. It is resumable and may be completed with `unknown` values. A shop
can continue setup without guessing. Submission creates an immutable assessment
revision; later edits create a new revision and retain the old pilot baseline.

The questions should take less than five minutes:

| Area | Baseline questions | Unit / allowed answer |
| --- | --- | --- |
| Team and capacity | Active operators; service bays/mobile crews; operating days | counts and days/week |
| Lead flow | Approximate new inquiries in a normal month; source mix | count plus website/SMS/phone/Meta/email/referral/other |
| Phone handling | Calls in a normal week; missed calls; calls returned | counts or unknown |
| Response | Typical first response to a new inquiry | minutes, bounded range or unknown |
| Conversion | Inquiries that become confirmed appointments | count/percentage or unknown |
| Work value | Typical booked service amount | optional USD amount/range or unknown |
| Follow-up | Unbooked inquiries followed up within two business days | count/percentage or unknown |
| Scheduling | Monthly cancellations/no-shows; scheduling conflicts | counts or unknown |
| Admin load | Owner/team hours per week spent on calls, follow-up, CRM and scheduling | hours or unknown |
| System readiness | CRM/spreadsheet/paper/none; calendar; active communication channels | finite choices |
| Pilot goal | One primary outcome and one secondary outcome | finite outcome choices plus bounded note |

Do not ask for revenue, payroll, customer lists or credentials merely to calculate a
baseline. Average booked value is optional. Connector credentials remain in the
existing server-side connection flow, never in assessment answers.

## Evidence contract

Each revision needs `shop_id`, assessment version, respondent, created/submitted
time, reporting period, raw answers and source classification:

- `owner_estimate`: the operator's best estimate.
- `connected_evidence`: calculated from a connected system with exact source and
  observation window.
- `gradia_observed`: calculated from Gradia's own event/interaction records.
- `derived`: deterministic formula over identified input revisions.
- `unknown`: intentionally not known; never converted to zero.

Store units with values. Preserve the question/catalog version. Derived metrics must
cite the exact inputs and formula version. Models may explain a metric but cannot
write, “correct” or upgrade its evidence class.

## Starting-point report

Show four factual sections rather than one synthetic score:

1. **Response** — inquiry volume, answer/missed-call rate and first-response time.
2. **Booking** — inquiry-to-confirmed-booking rate and cancellations/no-shows.
3. **Follow-up** — follow-up coverage and unresolved leads.
4. **Operating load** — reported admin hours and systems that require duplicate entry.

Every number displays its period and evidence label: `Owner estimate`, `Connected`,
or `Observed by Gradia`. Missing data says `Not measured yet`. Do not display
invented savings, estimated revenue gained or an improvement percentage without two
comparable evidence windows.

At day 30, prepare a comparison using the immutable starting revision and a new
observation window. Show only like-for-like measures. Changed definitions or missing
coverage produce `not comparable`, not an improvement claim.

## Authority and privacy

Owners submit and supersede the workspace baseline. Managers may enter a draft when
delegated; staff may not publish shop-wide baseline data. Revoked members lose read
and edit access immediately. Assessment data is tenant-bound and excluded from model
context unless a specific read-only report needs the minimized fields.

Deletion and retention follow the pilot privacy policy. A baseline is business
measurement evidence, not a reusable memory rule and never grants a tool, connector,
autonomy or customer-contact permission.

## Acceptance

- Solo and staffed fixtures can submit, resume and supersede an assessment without
  overwriting the original revision.
- `unknown` remains distinct from zero; invalid units/ranges fail validation.
- Derived results cite exact inputs, period and formula version.
- Cross-shop, staff, revoked and anonymous access is denied.
- A failed data load never renders a zero-performance report.
- The day-30 comparison refuses unlike periods/definitions and never invents ROI.

