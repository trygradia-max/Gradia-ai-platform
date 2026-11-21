/**
 * The ONLY files outside `src/lib/call-copilot/` (and the executor's pre-effect recheck wrapper) that may name Call Copilot.
 * PR F adds the owner / manager post-call review surface. Anything else naming it must be added here on purpose, in review.
 */
export const PR_F_REVIEW_FILES = [
  "src/app/(dashboard)/calls/copilot/[callId]/page.tsx",
  "src/app/(dashboard)/calls/copilot/page.tsx",
  "src/app/actions/call-copilot-review.ts",
  "src/app/team/calls/[callId]/page.tsx",
  "src/app/team/calls/page.tsx",
  "src/components/gradia/call-review/call-list.tsx",
  "src/components/gradia/call-review/capture-panel.tsx",
  "src/components/gradia/call-review/detail-view.tsx",
  "src/components/gradia/call-review/evidence-panel.tsx",
  "src/components/gradia/call-review/proposal-card.tsx",
  "src/components/gradia/call-review/proposal-list.tsx",
  "src/lib/call-review/decide.ts",
] as const
