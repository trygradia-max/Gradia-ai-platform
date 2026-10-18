import { z } from "zod"

export const BROWSER_UNAVAILABLE_SUMMARY = "No isolated browser service is configured for this workspace."
export const BROWSER_HANDOFF = "Sign-in and multi-factor checks stay with you. Gradia did not open a browser."

export const browserCheckDetailSchema = z.object({
  version: z.literal(1),
  provider: z.literal("none"),
  session_started: z.literal(false),
  credentials_stored: z.literal(false),
  local_machine_used: z.literal(false),
  named_provider_ignored: z.boolean(),
  summary: z.literal(BROWSER_UNAVAILABLE_SUMMARY),
  handoff: z.literal(BROWSER_HANDOFF),
}).strict()
export type BrowserCheckDetail = z.infer<typeof browserCheckDetailSchema>

/** The only browser result this slice can produce. No session, credential, or machine is involved. */
export function unavailableBrowserCheck(namedProviderIgnored: boolean): BrowserCheckDetail {
  return browserCheckDetailSchema.parse({
    version: 1,
    provider: "none",
    session_started: false,
    credentials_stored: false,
    local_machine_used: false,
    named_provider_ignored: namedProviderIgnored,
    summary: BROWSER_UNAVAILABLE_SUMMARY,
    handoff: BROWSER_HANDOFF,
  })
}
