# Component register — 2026-10-09

First visual slice: tokens plus Home, Conversations, and Customers. No
community installer was run. Base UI / shadcn wrappers keep their `render`
vs `asChild` APIs.

## Reused (no new primitive)

| Component | File | Why |
| --- | --- | --- |
| SectionHeader (now with action slot) | `src/components/gradia/section-header.tsx` | Page and section titles. SaaSUI note: do not add a second H1. |
| EmptyState | `src/components/gradia/empty-state.tsx` | Written empty states. Linear “No issues” is the visual ceiling ([SaaSUI empty-state/linear](https://www.saasui.design/pattern/empty-state/linear)). |
| StatusPill | `src/components/ui/status-pill.tsx` | Text + tone. Held → warn, failed → bad. |
| Skeleton | `src/components/ui/skeleton.tsx` | Loading shapes. Pulse off under `prefers-reduced-motion`. Cal.com hour bars are the reference ([SaaSUI cal-com](https://www.saasui.design/application/cal-com)). |
| AppShell / AppSidebar | `src/components/gradia/app-shell.tsx`, `app-sidebar.tsx` | Shell for these pages. Conversations stays “Conversations”. |
| Button, Input, Label, Card, Table | `src/components/ui/*` | Existing Base UI / shadcn wrappers. |
| InboxFrame, Whisper* | `src/components/gradia/inbox-frame.tsx`, `whisper-inbox-*.tsx` | #59 split panes and action contracts unchanged. |

## Added this slice

| Component | File | Source | License | Reason |
| --- | --- | --- | --- | --- |
| ErrorState | `src/components/gradia/error-state.tsx` | Extracted from `src/app/(dashboard)/error.tsx`. Shape matches EmptyState. No page-level error screenshot in the local SaaSUI set. | Original Gradia | Shared failed-load / unavailable card. |
| ListToolbar | `src/components/gradia/list-toolbar.tsx` | Gradia customers search + Home activity chips. Informed by Attio Filter/Sort ([SaaSUI attio](https://www.saasui.design/application/attio)) and Linear Display-as-local-option. | Original Gradia | Labelled search / status row. Filters must be server-backed or marked local. |
| Pagination | `src/components/gradia/pagination.tsx` | Extracted from Whisper Previous/Next. No in-product pager in the local SaaSUI set (`n/N` is gallery chrome). | Original Gradia | Named collection, no fake totals. |
| FormField | `src/components/gradia/form-field.tsx` | Thin label + hint + error wrapper over existing Input/Label. Informed by Linear create-team and Attio inline error ([SaaSUI linear](https://www.saasui.design/application/linear), [Attio onboarding](https://www.saasui.design/pattern/onboarding/attio)). Also [Origin UI forms](https://originui.com/) (MIT, browsed, not copied) and [shadcn theming](https://ui.shadcn.com/docs/theming) (MIT). | Original Gradia | Always-visible label; error on the field. |
| DetailSection | `src/components/gradia/detail-section.tsx` | SectionHeader + quiet card. Cal.com event-type detail and Attio settings blocks. | Original Gradia | Customer identity / pipeline blocks. |

ReviewCard was extracted in the Approvals / Activity slice (`src/components/gradia/review-card.tsx`) for delegated message evidence. Owner queue cards stay on `ApprovalsList` / `MotionCard` so equal-weight Send / Tweak / Drop is unchanged. The Team / Settings slice reuses ReviewCard on delivery holds, TeamChrome + SectionHeader on team/settings/control-center/receptionist, and layout-only billing chrome.

## Third-party sources consulted (not installed)

| URL | Author / product | License / terms | Used for |
| --- | --- | --- | --- |
| https://www.saasui.design | Rakesh Mondal (`@saasuidesign`) | Educational reference; cite SaaSUI + product | Pattern mapping in `REFERENCE_SAASUI_2026-10-09.md` |
| https://ui.shadcn.com/docs/theming | shadcn | MIT | Semantic token mapping |
| https://ui.shadcn.com/docs/components/base/sidebar | shadcn / Base UI | MIT | Confirm existing sidebar stack; no installer |
| https://base-ui.com/react/overview/accessibility | Base UI | MIT | Keep `render` wrappers |
| https://originui.com/ | Origin UI | MIT (site) | Restrained form/table density; no copy-paste |
| https://21st.dev/community/components/explore/shadcn-sidebar | 21st.dev community | Per-component | Browsed; none adopted |

No 21st.dev or registry component was copied into `src/components/ui`.
