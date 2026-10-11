# SaaSUI.design reference — 2026-10-09

Fit-based operating-software references for the Gradia charcoal / silver /
violet pass. This file records what the local screenshot set actually shows,
how those patterns map onto Gradia surfaces, and where the set is silent.
It is not a component installer, not a theme to copy, and not a ranking of
“best SaaS UI.”

Founder brief: `/Users/harryhatch/Gradia/worktrees/whisper-channel-evidence/docs/handoffs/CURSOR_UI_2026-10-09.md`.
Local captures: `docs/design/reference/saasui/`.
Cite SaaSUI.design when using its curation; cite the original product by name
when describing a screenshot.

---

## 1. Site overview, licensing, crawl

### What the site is

[SaaSUI.design](https://www.saasui.design) is a curated SaaS UI/UX pattern
library by [Rakesh Mondal](https://rakeshmondal.in) (`@saasuidesign`). Public
copy (2026-10-10 recrawl of `/llms.txt`) describes **3500+ screenshots from
100+ shipped products**, organized as application profiles, categories, and
screen-type pattern pages. It is editorial reference, not a design system and
not affiliated with the products shown.

### Dates

| Event | Date | Notes |
| --- | --- | --- |
| Local screenshot capture | **2026-10-09** | 15 files already in `docs/design/reference/saasui/`. Not recaptured. |
| This document | **2026-10-10** | Recrawled public pages and agent endpoints for URLs and license text. |
| SaaSUI agent catalog stamp | 2026-06-01 | `/llms-full.txt` and `/api/agent/screen-types` both say last updated 2026-06-01. The live library is newer (v0 profile dated 2026-10-09). |

Do not treat the 2026-06-01 stamp as the size of the library. Treat it as the
last published agent-catalog revision.

### Licensing / agent rules (from SaaSUI, not inferred)

Source: [https://www.saasui.design/llms.txt](https://www.saasui.design/llms.txt),
[https://www.saasui.design/llms-full.txt](https://www.saasui.design/llms-full.txt),
[https://www.saasui.design/markdown/about.md](https://www.saasui.design/markdown/about.md).

Allowed:

- Crawl public pages and sitemap URLs.
- Summarize and recommend application, category, pattern, blog, and glossary pages.
- Use screenshots as **educational reference** when linking back to SaaSUI.design.
- Cite SaaSUI.design in AI-generated answers.

Required:

- Attribute SaaSUI.design for its curation.
- Link the relevant SaaSUI page when referencing an example.
- Cite both SaaSUI.design **and** the original product name.
- Distinguish SaaSUI’s editorial framing from the product’s own claims.

Forbidden:

- Bulk-download or redistribute the screenshot collection.
- Imply affiliation with the products shown.
- Scrape Sanity Studio or private/mutation APIs.
- Submit automated spam through `/submit`.

`robots.txt` allows `/` and `/api/agent/`, disallows `/studio/` and other `/api/`.
This repo keeps a **small, named local set** for the component pass. Do not grow
it into a mirror.

### URL list used for this pass

**Site and agent**

- https://www.saasui.design/
- https://www.saasui.design/about
- https://www.saasui.design/llms.txt
- https://www.saasui.design/llms-full.txt
- https://www.saasui.design/robots.txt
- https://www.saasui.design/sitemap.xml
- https://www.saasui.design/api/agent/site-catalog
- https://www.saasui.design/api/agent/screen-types
- https://www.saasui.design/api/agent/search?q=inbox
- https://www.saasui.design/api/agent/applications

**Categories and pattern indexes**

- https://www.saasui.design/categories
- https://www.saasui.design/category/crm
- https://www.saasui.design/pattern/login
- https://www.saasui.design/pattern/onboarding
- https://www.saasui.design/pattern/dashboard
- https://www.saasui.design/pattern/settings
- https://www.saasui.design/pattern/navigation
- https://www.saasui.design/pattern/empty-state
- https://www.saasui.design/pattern/form
- https://www.saasui.design/pattern/table
- https://www.saasui.design/pattern/email
- https://www.saasui.design/pattern/calendar
- https://www.saasui.design/pattern/billing
- https://www.saasui.design/pattern/analytics
- https://www.saasui.design/pattern/chat
- https://www.saasui.design/pattern/modal

**Application profiles in the local set**

| Product | SaaSUI profile | Product site |
| --- | --- | --- |
| Attio | https://www.saasui.design/application/attio | https://attio.com/ |
| Front | https://www.saasui.design/application/front | https://front.com/ |
| Linear | https://www.saasui.design/application/linear | https://linear.app/ |
| Asana | https://www.saasui.design/application/asana | https://asana.com/ |
| Resend | https://www.saasui.design/application/resend | https://resend.com/ |
| Notion | https://www.saasui.design/application/notion | https://www.notion.so/ |
| Skiff | https://www.saasui.design/application/skiff | https://skiff.com/ |
| Sunsama | https://www.saasui.design/application/sunsama | https://www.sunsama.com/ |
| Cal.com | https://www.saasui.design/application/cal-com | https://cal.com/ |
| Close | https://www.saasui.design/application/close-crm | https://www.close.com/ |
| Stripe | https://www.saasui.design/application/stripe | https://stripe.com/ |

**Pattern-detail pages that match local files**

- https://www.saasui.design/pattern/onboarding/attio (5 Attio onboarding shots)
- https://www.saasui.design/pattern/settings/attio (3 Attio settings shots)
- https://www.saasui.design/pattern/email/front (2 Front email shots)
- https://www.saasui.design/pattern/empty-state/linear (3 Linear empty-state shots)
- https://www.saasui.design/pattern/form (index; Linear create-team is a settings form)
- https://www.saasui.design/pattern/table (index; Asana listed)
- https://www.saasui.design/pattern/settings (index; Resend, Notion, Sunsama, Attio, Linear)
- https://www.saasui.design/pattern/email (index; Front, Skiff, Close)
- https://www.saasui.design/pattern/calendar (index; Cal.com)
- https://www.saasui.design/pattern/dashboard (index; Close, Asana, Attio)
- https://www.saasui.design/pattern/billing (index; Stripe, Cal.com)
- https://www.saasui.design/pattern/login (index; Attio, Cal.com, Sunsama — **no local login capture**)

**Editorial pages worth opening before inventing a layout**

- https://www.saasui.design/blog/saas-list-detail-master-detail-ux-patterns
- https://www.saasui.design/blog/saas-email-inbox-ux-patterns
- https://www.saasui.design/blog/saas-activity-feed-audit-log-ux-patterns
- https://www.saasui.design/blog/saas-login-ux-patterns
- https://www.saasui.design/blog/saas-multi-step-form-wizard-ux-patterns
- https://www.saasui.design/glossary/empty-state

### Local screenshot inventory (15)

Gallery chrome on every file: black letterbox, prev/next chevrons, and a
`n/N` counter (for example `8/25`). That counter is **SaaSUI’s carousel**,
not in-product pagination. Do not copy it.

| File | Product | What it actually shows |
| --- | --- | --- |
| `01-attio-list-view-shell.png` | Attio | Light CRM shell: icon sidebar, search, named list, stage columns, filter/sort/view toolbar. Visible gallery index `8/25`. |
| `02-attio-settings-general.png` | Attio | Full-page settings: sectioned sidebar, breadcrumb, title + one-line purpose, labelled fields, empty export table. URL chrome: `https://app.attio.com/saasui/settings/workspace`. |
| `03-attio-onboarding-step-2of5-inline-error.png` | Attio | Step `2/5`, split preview, labelled fields, **inline field error** (red border + “Please enter a workspace handle”), one primary Continue. |
| `04-front-shared-inbox-three-pane.png` | Front | Three-pane shared inbox: folder nav, conversation list with unread dots + timestamps, reading pane, composer. Filters Unassigned / Assigned / Archived. URL chrome: Front unassigned folder. |
| `05-linear-settings-create-team-form.png` | Linear | Settings form: title + purpose, labelled fields, helper text, switches with consequences, one primary Create. |
| `06-linear-empty-state-display-popover.png` | Linear | Honest empty list (“No issues”), filter tabs, **Display** popover (grouping, ordering, visible properties). No illustration. |
| `07-asana-dark-list-table.png` | Asana | Dark grouped list/table: sidebar + top search, view tabs, filter/sort/search toolbar, collapsible sections, priority pills. |
| `08-resend-dark-settings-team.png` | Resend | Near-black settings: sidebar, page title, Billing / Team tabs, invite field + members list in hairline cards. |
| `09-notion-dark-settings-modal.png` | Notion | Dark settings **modal**: left section nav, stacked preference rows, toggles and selects, dimmed canvas behind. |
| `10-skiff-dark-mail-inbox.png` | Skiff | Dark mail list: sidebar folders, unread count, row checkboxes, unread dots. Also a green promo banner, blue notification bar, and a calendar upsell card — do not copy those. |
| `11-sunsama-dark-settings-general.png` | Sunsama | Dark full-page settings: return link, grouped sidebar, title, row-per-preference (label / help / control). |
| `12-calcom-event-type-tabs-skeleton.png` | Cal.com | Event-type detail: back + title, secondary nav, **skeleton bars** for weekly hours, one Save. URL chrome: Cal.com event-type availability tab. |
| `13-close-crm-activity-overview-metrics.png` | Close | Activity Overview of **empty metric tiles** (zeros, “Not enough data”). Use as a caution, not a Home target. |
| `14-stripe-create-invoice-preview.png` | Stripe | Split editor + live preview, labelled sections, radios with consequences, one Review action. Test-mode banner. |
| `15-stripe-nav-more-flyout-stepper.png` | Stripe | Overflow **More** flyout, 3-step setup stepper, test-mode banner. |

No extra screenshots were added. The missing Gradia surfaces (HITL review
queue, login, page error, in-product pagination, customer record detail) are
not fixed by grabbing one more marketing-adjacent gallery frame. Cite the
pattern URLs in §6 instead of growing the local set.

---

## 2. Patterns by Gradia surface

Each row is a concrete example from the local set, plus the SaaSUI page to
cite. “Reuse first” points at an existing Gradia file so the pass extends
wrappers instead of cloning a demo.

### Shell / every page

**Take:** Narrow icon-or-label sidebar, current item as a quiet raised row,
page title in the content pane (not a second brand lockup), one search or
command entry. Light refs (Attio, Front, Linear, Cal.com, Stripe) put the
title in the canvas; dark refs (Asana, Resend, Sunsama) do the same on a
lifted charcoal pane.

| Example | Product | URL | File |
| --- | --- | --- | --- |
| CRM list shell | Attio | https://www.saasui.design/application/attio | `01-attio-list-view-shell.png` |
| Settings shell + breadcrumb | Attio | https://www.saasui.design/pattern/settings/attio | `02-attio-settings-general.png` |
| Dark app chrome | Asana | https://www.saasui.design/application/asana | `07-asana-dark-list-table.png` |
| Overflow nav + stepper | Stripe | https://www.saasui.design/application/stripe | `15-stripe-nav-more-flyout-stepper.png` |

Reuse first: `src/components/gradia/app-shell.tsx`, `app-sidebar.tsx`.
`PageTitle` is only the topbar destination label — it is not a page header.

Also: https://www.saasui.design/pattern/navigation,
https://www.saasui.design/blog/saas-list-detail-master-detail-ux-patterns.

### Home

**Take:** A page title and an honest list of work. Close’s Activity Overview
(`13`) is the anti-pattern: a grid of zeroed KPI tiles and a “not enough
data” illustration. Gradia Home may show counts only when they are real and
clickable (needs-review → Approvals). No sparkline theater, no “agents are
watching” copy.

| Example | Product | URL | File |
| --- | --- | --- | --- |
| Empty metric dashboard (caution) | Close | https://www.saasui.design/application/close-crm | `13-close-crm-activity-overview-metrics.png` |
| Written empty + next action | Linear | https://www.saasui.design/pattern/empty-state/linear | `06-linear-empty-state-display-popover.png` |

Reuse first: `dashboard-hero.tsx`, `activity-feed.tsx`, `booked-today.tsx`,
`kpi-row.tsx`. Prefer a written empty state over a tile of `0`.

Also: https://www.saasui.design/blog/saas-activity-feed-audit-log-ux-patterns.

### Approvals and manager approvals

**Take:** No HITL “approve and send” queue exists in the local set or in a
SaaSUI search for “review” / “approval.” Closest operational pattern is
Stripe’s create-invoice split: evidence on the right, labelled fields on the
left, one primary Review action, secondary options as radios with
consequences — not a row of equal buttons.

| Example | Product | URL | File |
| --- | --- | --- | --- |
| Evidence + preview + one primary | Stripe | https://www.saasui.design/application/stripe | `14-stripe-create-invoice-preview.png` |
| Shared inbox triage (not approval) | Front | https://www.saasui.design/pattern/email/front | `04-front-shared-inbox-three-pane.png` |

Reuse first: `approvals-list.tsx`, `record-proposal-review.tsx`,
`whisper-reply-evidence.tsx`, `message-delivery-review.tsx`. Extract a
`ReviewCard` from those; do not invent a dashboard card from Close tiles.

Gradia actions stay Approve and send / Edit & approve / Reject (or dismiss).
Do not collapse that to Front’s Reply.

### Activity

**Take:** Actor, object, time, and a status that means something. Front’s
list rows (name, preview, timestamp, unread) and Asana’s grouped rows beat
Close’s metric board. SaaSUI’s activity-feed essay is the better written
reference than any local screenshot.

| Example | Product | URL | File |
| --- | --- | --- | --- |
| Dense event-like rows | Front | https://www.saasui.design/pattern/email/front | `04-front-shared-inbox-three-pane.png` |
| Grouped list with status pills | Asana | https://www.saasui.design/pattern/table | `07-asana-dark-list-table.png` |
| Empty metric board (caution) | Close | https://www.saasui.design/application/close-crm | `13-close-crm-activity-overview-metrics.png` |

Reuse first: `activity-feed.tsx`, `activity-event.tsx`,
`interaction-timeline.tsx`. Filters must match server results.

Also: https://www.saasui.design/blog/saas-activity-feed-audit-log-ux-patterns.

### Conversations

**Take:** Preserve the #59 list-detail split. Front is the primary light
reference: three panes, labelled unread, folder/state filters, selected row
that stays visible, reading pane that names recipient / subject / time.
Skiff is the dark list reference (unread count, dots, row density) after
stripping the promo banners.

| Example | Product | URL | File |
| --- | --- | --- | --- |
| Three-pane shared inbox | Front | https://www.saasui.design/pattern/email/front | `04-front-shared-inbox-three-pane.png` |
| Dark mail list | Skiff | https://www.saasui.design/application/skiff | `10-skiff-dark-mail-inbox.png` |

Reuse first: `inbox-frame.tsx`, `whisper-inbox-presentation.tsx`,
`whisper-inbox-controls.tsx`, `conversation-threads.tsx`.

Also: https://www.saasui.design/blog/saas-email-inbox-ux-patterns,
https://www.saasui.design/blog/saas-list-detail-master-detail-ux-patterns.

### Customers / detail / vehicles

**Take:** Attio’s named list + toolbar is the collection pattern (search,
filter, sort, view). There is **no customer-record detail** in the local
set. Closest detail chrome is Cal.com’s event-type page: back control,
title, secondary tabs, one Save, skeletons while a section loads.

| Example | Product | URL | File |
| --- | --- | --- | --- |
| Collection / pipeline list | Attio | https://www.saasui.design/application/attio | `01-attio-list-view-shell.png` |
| Dark grouped table | Asana | https://www.saasui.design/application/asana | `07-asana-dark-list-table.png` |
| Detail header + tabs + skeleton | Cal.com | https://www.saasui.design/application/cal-com | `12-calcom-event-type-tabs-skeleton.png` |

Reuse first: `customers-table.tsx`, `customer-summary-card.tsx`. Search is
already server-backed via `?q=`.

### Leads / pipeline

**Take:** Attio’s stage columns are a pipeline **chrome** reference (named
stages, add-to-list affordance), not a license to invent drag semantics the
backend does not have. Keep current lead routes and real next-action
fields.

| Example | Product | URL | File |
| --- | --- | --- | --- |
| Stage columns in a list shell | Attio | https://www.saasui.design/application/attio | `01-attio-list-view-shell.png` |

Reuse first: `pipeline-board.tsx`, `src/app/(dashboard)/leads/page.tsx`.

### Calendar / quotes

**Take:** Cal.com for schedule detail (availability section, weekday rows,
skeletons). Stripe invoice for quote editor sections (items, options,
preview). Do not copy Stripe’s payment collection radios into Gradia
billing behavior.

| Example | Product | URL | File |
| --- | --- | --- | --- |
| Event detail + hour skeletons | Cal.com | https://www.saasui.design/pattern/calendar | `12-calcom-event-type-tabs-skeleton.png` |
| Editor + preview | Stripe | https://www.saasui.design/pattern/billing | `14-stripe-create-invoice-preview.png` |

Reuse first: `calendar-week.tsx`, `quote-builder.tsx`, `quotes-list.tsx`.

### Team / assigned work / delivery reviews

**Take:** Linear create-team for member/grant forms (helpers, switches that
state what will and will not copy). Resend Team for invite + member list on
dark cards. Sunsama/Attio for the settings IA around those forms.

| Example | Product | URL | File |
| --- | --- | --- | --- |
| Create-team form | Linear | https://www.saasui.design/application/linear | `05-linear-settings-create-team-form.png` |
| Dark invite + members | Resend | https://www.saasui.design/application/resend | `08-resend-dark-settings-team.png` |

Reuse first: `src/app/team/team-panel.tsx`,
`delivery-reconciliation-history.tsx`, `src/app/team/approvals/page.tsx`.

### Intake review

**Take:** Same evidence-card idea as Approvals. Stripe preview shows how to
keep submitted fields readable beside the action. Attio onboarding shows
how to mark an invalid field without toasting the whole page. No dedicated
ambiguity/identity screenshot.

| Example | Product | URL | File |
| --- | --- | --- | --- |
| Split evidence / preview | Stripe | https://www.saasui.design/application/stripe | `14-stripe-create-invoice-preview.png` |
| Inline invalid field | Attio | https://www.saasui.design/pattern/onboarding/attio | `03-attio-onboarding-step-2of5-inline-error.png` |

Reuse first: `intake-review-queue.tsx`, `intake-identity-form.tsx`,
`record-proposal-details.tsx`.

### Settings / Control Center / receptionist

**Take:** This is the strongest cluster in the set. Shared rules: sectioned
left nav, title + one-line purpose, **one preference per row** (label,
help, control), hairline dividers, switches that explain the consequence,
one primary per task region.

| Example | Product | URL | File |
| --- | --- | --- | --- |
| Full-page general settings | Attio | https://www.saasui.design/pattern/settings/attio | `02-attio-settings-general.png` |
| Create form inside settings | Linear | https://www.saasui.design/application/linear | `05-linear-settings-create-team-form.png` |
| Dark tabbed team settings | Resend | https://www.saasui.design/application/resend | `08-resend-dark-settings-team.png` |
| Dark settings modal | Notion | https://www.saasui.design/application/notion | `09-notion-dark-settings-modal.png` |
| Dark row-per-preference | Sunsama | https://www.saasui.design/application/sunsama | `11-sunsama-dark-settings-general.png` |
| Detail tabs + skeleton | Cal.com | https://www.saasui.design/application/cal-com | `12-calcom-event-type-tabs-skeleton.png` |

Reuse first: `settings-section-nav.tsx`, `capability-row.tsx`, the
`*-settings-card.tsx` family, Control Center page. Prefer Sunsama/Resend
**page** settings for Control Center; Notion’s **modal** is for focused
account prefs, not the whole policy surface.

### Onboarding / login

**Take:** Attio `2/5` is the onboarding reference: honest step index, labelled
fields, helper under the control, inline error, preview of the thing being
created, one Continue. Stripe `15` is a 3-step stepper after signup, not a
login screen. **No login screenshot is in the local set.**

| Example | Product | URL | File |
| --- | --- | --- | --- |
| Step + inline error + preview | Attio | https://www.saasui.design/pattern/onboarding/attio | `03-attio-onboarding-step-2of5-inline-error.png` |
| Post-auth stepper + overflow nav | Stripe | https://www.saasui.design/application/stripe | `15-stripe-nav-more-flyout-stepper.png` |

Reuse first: `onboarding-wizard.tsx`, `login-form.tsx`. Keep auth/redirect
behavior unchanged. For login chrome see
https://www.saasui.design/pattern/login and
https://www.saasui.design/blog/saas-login-ux-patterns — do not restyle the
public cinematic login into dashboard chrome.

### Billing

**Take:** Layout only. Stripe’s test-mode banner, sectioned invoice form,
and preview pane are the visual reference. Do not add prices, plans, trial
offers, entitlements, or payment behavior from the screenshot.

| Example | Product | URL | File |
| --- | --- | --- | --- |
| Invoice editor + preview | Stripe | https://www.saasui.design/pattern/billing | `14-stripe-create-invoice-preview.png` |

Reuse first: `billing-subscribe.tsx`, `usage-pill.tsx`, `usage-meters.tsx`.

---

## 3. Dark-theme colour observations → Gradia tokens

Sampled from the product window inside each 1920×1080 PNG (letterbox
excluded). These are observed pixels, not the products’ published tokens.

| Product | Canvas / page | Sidebar or rail | Raised row / card | Notes |
| --- | --- | --- | --- | --- |
| Asana | `#1C1D1E` | `#29292A` | `#2C2C30` hairlines | Neutral charcoal, not blue. Priority pills carry yellow / coral. |
| Resend | `#09090D` | same near-black | `#18181C` card edge | Darker than Gradia canvas. Elevation is a 1px line, not a fill jump. |
| Notion modal | `#1D1D1D` | `#121212` | `#202020` rows | Backdrop is dimmed canvas. Toggles are **blue**, not violet. |
| Skiff | `#1D1D1D` | `#191919` | `#212121` rows | Same family as Notion. Promo green `#50B878` and info blue `#5CADE6` are banners — ignore. |
| Sunsama | `#202021` | `#1C1C1D` | same, row dividers | One surface, hierarchy from type and dividers. Controls are blue. |

None of the dark captures use Gradia violet as the filled primary. Stripe
(light) is the only local file where purple is a product accent. Dark refs
prove **lifted charcoal + hairline + silver text**, not the accent hue.

### Token mapping

Founder targets from the 2026-10-09 brief. Contrast numbers below are the
brief’s calculated opaque pairs; validate rendered opacity separately.

| Role | Gradia target | What the dark set does | Use it like this |
| --- | --- | --- | --- |
| Canvas | `#101217` | Resend `#09090D` is blacker; Asana/Notion/Skiff sit near `#1C1D1E`. | Keep the cooler blue-black. Do not flatten to Resend true-black or warm Asana gray. |
| Card / sidebar | `#181B22` | Notion rail `#121212`, Skiff rail `#191919`, Sunsama `#1C1C1D`. | One step up from canvas. Sidebar and cards share this, as in Resend/Sunsama. |
| Raised / popover | `#222630` | Asana rail `#29292A`, Skiff row `#212121`, Notion row `#202020`. | Popovers, Display menus, selected rows. Linear’s Display panel is the shape; this is the fill. |
| Hover | `#2A303C` | Asana mid `#2C2C30`. | Quiet row/nav hover. No colored hover fill (Linear rule already in `globals.css`). |
| Decorative divider | `#303642` | Asana/Skiff hairlines `#2C2C30`–`#303030`. | Settings row rules, table lines. Cooler than the refs, same job. |
| Input / control boundary | `#64748B` | Dark refs draw **quieter** borders (`#2A2A2E`–`#484848`) and save mid-slate for icons. | Brief already flags 3.18:1 on raised. Use `#64748B` on inputs/buttons so the control is findable; do not paint every card edge that loud. |
| Primary text | `#F4F5F7` | Near-white `#FCFCFC` on Asana/Resend/Notion. | Cooler than pure white. Matches the brief, not a second cream. |
| Secondary text | `#A5ADBA` | Notion/Resend ~`#A8A8A8`, Sunsama values ~`#D0D0D0`. | Helpers, timestamps, unselected nav. |
| Primary filled | `#7C3AED` + `#FFFFFF` | Absent in the dark set. Stripe (light) is the accent cousin. | Identity. One filled CTA per task region, as Linear/Attio/Cal.com do with blue. |
| Primary hover | `#6D28D9` | Not sampled (no violet buttons). | Keep. |
| Links / focus / selected | `#A78BFA` | Refs use product blue for focus/toggles. | Focus ring and selected emphasis. Not a second fill color. |
| Success | `#4ADE80` | Skiff banner green `#50B878` (do not copy the banner). Asana teal is avatar chrome, not status. | Status pill + icon + text only. |
| Attention / held | `#FBBF24` | Asana “Low” pill ~gold. | Held / unread / needs review. |
| Error / destructive | `#FB7185` | Attio inline error (light red border + text). Asana “Medium” coral. Skiff unread dot. | Field errors and destructive status, with text. |

Current `globals.css` still uses near-black `oklch` canvas (`--bg-canvas:
oklch(0.06 0 0)`) and already has `--accent: #7C3AED`, `--accent-hover:
#6D28D9`, `--accent-text: #A78BFA`, `--status-*-fg` matching success /
attention / error. This pass retokens the **neutrals** toward the table
above; it does not introduce a theme switch.

---

## 4. Component recommendations

Prefer the existing file. Add a wrapper only when three or more routes
reimplement the same chrome.

### PageHeader

**Job:** One `<h1>` per page, optional short purpose line, optional right
slot for the single primary action or a status cluster.

**From the set:** Attio Settings “General” + purpose; Linear “Create a new
team” + purpose; Resend “Settings”; Cal.com back + “15 Min Meeting” + Save;
Sunsama “General” under a Return link.

**Reuse:** `SectionHeader` with `level={1}` already does eyebrow + title +
subhead. `PageTitle` stays the topbar label. Do not create a second H1
component unless `SectionHeader` cannot take a right-side action slot.

**Do:** Geist 600 title, muted purpose, one primary. **Don’t:** breadcrumb
plus title plus eyebrow plus icon lockup.

### SectionHeader

**Job:** Eyebrow + headline + optional subhead inside a page.

**From the set:** Stripe “Customer / Items / Payment collection”; Notion
“My notifications / My settings”; Attio “Workspace logo / Export workspace
data”; Sunsama grouped Account / Workspace / Integrations.

**Reuse:** `src/components/gradia/section-header.tsx` — already the only
section header.

### ListToolbar

**Job:** Search, filters, sort, view options. Every control must change the
**server** result set, or it is labelled as a local display option (Linear
Display).

**From the set:** Attio Filter / Sort / View / Import; Front Unassigned /
Assigned + Filter + Newest; Linear Assigned / Created / Display popover;
Asana Filter / Sort / Search on the dark table.

**Reuse:** customers `?q=` search, whisper inbox filters, activity chips.
Extract a `ListToolbar` when the markup repeats. Never present one-page
filtering as database-wide filtering.

### EmptyState

**Job:** Written title, one sentence, optional single action. First-use
teaches; no-results offers Clear filters; all-done reassures.

**From the set:** Linear “No issues” (check + short label, no art); Attio
export table “You have not created any exports.”; Close “Not enough data”
is weaker (illustration + tips).

**Reuse:** `src/components/gradia/empty-state.tsx`. Delete local
`EmptyState` functions inside `approvals-list.tsx` and `customers-table.tsx`
when they drift.

### ErrorState

**Job:** Same shape as empty, different copy and actions: what failed, Retry,
safe exit. Inline field errors stay on the field (Attio handle).

**From the set:** Only Attio’s inline invalid field. **No page-level error
screenshot.**

**Reuse:** `src/app/(dashboard)/error.tsx` already matches the empty-state
card. Promote that markup to a shared `ErrorState` so inbox / customers /
team failed-load views do not invent a third card.

### LoadingSkeleton

**Job:** Preserve layout while data loads. Bars and rows, not a centered
spinner, for page bodies.

**From the set:** Cal.com weekday rows as gray bars (`12`). Front/Attio do
not show a load state in this set.

**Reuse:** `src/components/ui/skeleton.tsx`. Respect
`prefers-reduced-motion` (pulse off). Shape skeletons like the real rows
(inbox row, settings row, table row), as Cal.com does for hours.

### StatusPill

**Job:** Text (+ optional icon). Color is not the only signal.

**From the set:** Asana Low / Medium pills; Front unread dots (dot +
preview is acceptable for unread, but a labelled pill is clearer for
handoff / held / failed); Skiff Inbox `2` count.

**Reuse:** `src/components/ui/status-pill.tsx` (`good` / `warn` / `bad` /
`accent` / `muted`). Map held → `warn`, failed/rejected → `bad`, sent →
`good`, new handoff → `accent`. Do not add a sixth tone for decoration.

### FormField

**Job:** Visible label, control, helper, optional inline error. 6px radius
inputs. Error is border + text, not a toast.

**From the set:** Linear create-team (label, example, helper, switch
consequence); Attio workspace name / handle with inline error; Resend
invite email; Sunsama preference rows.

**Reuse:** existing `Input` / `Label` / `shadcn` field wrappers. A thin
`FormField` that always renders label + described-by helper + error id is
enough. Do not pull a form library for this pass.

### ReviewCard

**Job:** Recipient or object, body/evidence, status, explicit Approve and
send vs Reject (plus Edit & approve where that already exists). Pending and
uncertain are labelled, not implied by color.

**From the set:** Stripe invoice preview is the only evidence+action split.
Nothing shows a dual approve/reject pair.

**Reuse:** extract from `approvals-list.tsx` / `record-proposal-review.tsx`
/ `whisper-reply-evidence.tsx`. One dominant primary (approve-and-send).
Reject is outline/destructive, never a second filled purple.

### DetailSection

**Job:** A titled block on a record or settings page: heading, optional
help, body, optional section action.

**From the set:** Attio Workspace logo / Export; Stripe Customer / Items;
Cal.com Availability; Notion grouped preference blocks; Resend Invite /
Members cards.

**Reuse:** settings cards and `SectionHeader` + card. Standardize padding
(10px card radius) and the “title left, action right” row before adding a
new primitive.

### Pagination

**Job:** Previous / Next (or Load more) that names the collection and does
not pretend the current page is the whole database.

**From the set:** **None.** The `8/25` marks are SaaSUI gallery chrome.

**Reuse:** intake and delivery-review `Previous` / `Next` links; approvals
“load more” slice. One shared `Pagination` with `aria-label` on the nav,
disabled ends, and a text status (“Showing 1–20 of 47”) when the total is
real. Do not add page-number theater without a total.

---

## 5. Anti-patterns

Do not bring these into Gradia dashboard surfaces, even if a screenshot
contains them.

| Anti-pattern | Where it appears | Why it is out |
| --- | --- | --- |
| Ornamental gradients | Public Gradia pages only; not in this operating set | Founder brief; dashboard stays flat charcoal. |
| Glass / blur panels | Notion dimmed backdrop is fine; frosted cards are not | Brief + BUILD_REFERENCE: cinematic layer is public-only. |
| Animated borders / glow | Not in the local set; do not add | Reduced-motion; looks like marketing. |
| Fake or empty charts | Close Activity Overview zeros | Decorative dashboard metrics. Home counts must be real or omitted. |
| Decorative metric tiles | Close `13` | “0 outbound calls / $0 won” teaches nothing and claims a BI surface Gradia does not ship. |
| Promo / download banners | Skiff green + blue bars | Not status, not a next action, steals the primary scan line. |
| Upsell cards on the work surface | Skiff calendar card; Attio “Upgrade” in the rail | Billing has its own page. Conversations do not sell add-ons. |
| Illustration-led empty states | Close “not enough data” figure | Gradia empty states are written. Linear’s check + sentence is the ceiling. |
| Color-only status | Asana pills are close; still pair with words | Status = icon + text. |
| Many equal primaries | Avoid Front’s many text buttons becoming filled purple | One dominant CTA per task region. |
| Gallery chrome | `n/N` chevrons on every PNG | Not product UI. |
| Copying Stripe payment radios | `14` | Billing layout only; no new payment behavior. |
| Blue-from-Notion toggles as a second accent | Notion, Sunsama | Gradia switches stay neutral track + violet/selected emphasis, not a blue brand. |
| Staggered row theater on first paint | — | 100–150ms functional motion only; honor reduced motion. |

---

## 6. Honest gaps

1. **No HITL approval queue.** SaaSUI search for review/approval returned
   product profiles and billing essays, not an approve-and-send inbox.
   ReviewCard is inferred from Stripe preview + existing Gradia approvals
   markup. That inference is weaker than a real reference.

2. **No login capture.** Pattern index:
   https://www.saasui.design/pattern/login (Attio, Cal.com, Sunsama are
   listed). Local set starts after auth except Attio onboarding.

3. **No page-level error or unavailable state.** Only Attio inline field
   error. Failed inbox / customers / team loads have no SaaSUI twin here.

4. **No in-product pagination.** Do not mistake SaaSUI `8/25` for a pager.
   Table pattern index claims pagination examples; none were captured.

5. **No customer / vehicle record detail.** Attio is a collection. Cal.com
   is a settings-detail stand-in. Tabs, history, and empty vehicles are
   underspecified.

6. **Home is only specified by negation.** Close shows what not to build.
   There is no honest “today’s work” home in the 15 files.

7. **Dark refs are neutral gray; Gradia is cooler charcoal + violet.**
   Steal elevation and density, not hue. Do not “correct” `#101217` toward
   Asana `#1C1D1E` or Resend `#09090D`.

8. **Control-boundary loudness.** Founder `#64748B` is more visible than
   Resend/Notion hairlines. That is intentional for 3:1 controls; it will
   look “brighter” than these screenshots if applied to every card edge.

9. **Skiff is a closed product** in the library (privacy suite, later
   wound down). Use it only as a dark inbox density reference.

10. **Screenshot IDs are not on the files.** The 15 PNGs were captured
    2026-10-09 from the SaaSUI gallery; this recrawl confirmed product
    slugs and pattern pages but not the original Sanity asset IDs. If a
    later recrawl needs exact frames, re-open the application page rather
    than downloading the whole collection.

11. **BUILD_REFERENCE still describes KPI sparklines and a glass-box
    Home.** The founder brief for this pass outranks that for dashboard
    decoration. Do not reintroduce sparklines because an older spec or a
    Close screenshot shows tiles.

12. **No extra screenshots added.** A login frame, a record-detail frame,
    and a real review queue would help. They are not in the local set, and
    SaaSUI’s license forbids bulk-mirroring to fill the holes.

---

## 7. How to use this file

1. Pick the Gradia surface in §2. Open the listed PNG and the SaaSUI URL.
2. Reuse the Gradia file named there. Match density, hierarchy, and
   empty/error/load behavior — not the product’s accent color.
3. Apply tokens from §3 through CSS variables, not raw hex in components.
4. If a UI need requires a backend contract (true totals, filter semantics,
   approve/reject), ask in the handoff. Do not fake it in the component.

Related in-repo docs: `docs/BUILD_REFERENCE.md` (voice, type, existing
inventory), `docs/design/reference/saasui/` (the 15 frames), founder brief
cited above.
