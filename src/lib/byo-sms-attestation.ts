import { z } from "zod"

/**
 * Owner attestation that a bring-your-own (non-Gradia) number is registered for
 * A2P 10DLC. It is the only path that sets `shops.byo_sms_verified`, which
 * `smsGateForShop` requires before any text leaves such a number. Gradia numbers
 * keep their own A2P gate. BYO is the advanced path: only a number sent through
 * the shop's own Twilio credentials can be attested. A confirmed number is
 * "Ready to test", never "Ready". Contract: docs/architecture/BYO_SMS_ATTESTATION.md.
 */

/** Must equal the version the database function accepts (migration 20261015150000). */
export const BYO_SMS_ATTESTATION_STATEMENT_VERSION = "2026-10-16"

/** Shown verbatim to the owner next to the confirm control. Changing it means a new version, here and in SQL. */
export const BYO_SMS_ATTESTATION_STATEMENT =
  "I confirm this phone number is on my own Twilio account and is registered there for A2P 10DLC texting, in a " +
  "Messaging Service whose campaign was approved for my business, and that the texts Gradia sends from it fit that campaign. " +
  "If the registration lapses, is suspended or moves to another number, I'll withdraw this confirmation."

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

export const byoSmsShopSchema = z.object({ shopId: uuid }).strict()

export const byoSmsAttestSchema = z.object({
  shopId: uuid,
  /** The number the owner was shown, exactly as `read` returned it. A different current number refuses. */
  phoneE164: z.string().regex(/^\+[1-9]\d{6,14}$/),
  statementVersion: z.literal(BYO_SMS_ATTESTATION_STATEMENT_VERSION),
  /** The owner ticked the statement. Nothing else stands in for it. */
  confirm: z.literal(true),
}).strict()
export type ByoSmsAttestInput = z.infer<typeof byoSmsAttestSchema>

const timestamp = z.string().datetime({ offset: true })

export const byoSmsAttestationStateSchema = z.object({
  /**
   * no_number: nothing to attest. gradia_number: the A2P gate applies instead.
   * not_own_account: the number isn't sent through the shop's own Twilio credentials,
   * so it can't be attested (texts held). unconfirmed: texts from this number are held.
   * confirmed: the owner attested this number on their own account.
   */
  state: z.enum(["no_number", "gradia_number", "not_own_account", "unconfirmed", "confirmed"]),
  phone_e164: z.string().nullable(),
  current_statement_version: z.string(),
  last_event: z.object({
    event: z.enum(["attested", "revoked", "cleared"]),
    source: z.enum(["owner_attestation", "owner_revocation", "number_changed", "account_changed"]),
    phone_e164: z.string().nullable(),
    actor_user_id: uuid.nullable(),
    statement_version: z.string().nullable(),
    created_at: timestamp,
  }).strict().nullable(),
}).strict()
export type ByoSmsAttestationState = z.infer<typeof byoSmsAttestationStateSchema>

/**
 * The texting status shown for an own number, in the onboarding status vocabulary
 * (ONBOARDING_AND_BUSINESS_UX_HANDOFF.md). Never "Ready": the attestation is the
 * owner's word, and consent, quiet hours and release gates still apply at send.
 * `null` for a Gradia number, whose status comes from its A2P registration.
 */
export type ByoSmsSetupStatus = "Not set up" | "Needs your details" | "Ready to test"
export function byoSmsSetupStatus(state: ByoSmsAttestationState["state"]): ByoSmsSetupStatus | null {
  switch (state) {
    case "no_number": return "Not set up"
    case "gradia_number": return null
    case "not_own_account": return "Needs your details"
    case "unconfirmed": return "Needs your details"
    case "confirmed": return "Ready to test"
  }
}

const attestedSchema = byoSmsAttestationStateSchema.extend({ status: z.enum(["attested", "already_attested"]) })
const revokedSchema = byoSmsAttestationStateSchema.extend({ status: z.enum(["revoked", "already_revoked"]) })
export const byoSmsAttestResponseSchema = attestedSchema
export const byoSmsRevokeResponseSchema = revokedSchema

type Refusal =
  | { ok: false; code: "invalid"; field: "shopId" | "phoneE164" | "statementVersion" | "confirm" | "command" }
  | { ok: false; code: "forbidden" | "not_confirmed" | "uncertain" }

/** Every refusal is safe to show; `uncertain` may be retried as is (both writes are idempotent by state). */
export type ByoSmsReadResult = { ok: true; attestation: ByoSmsAttestationState } | Refusal
export type ByoSmsAttestResult =
  | { ok: true; status: "attested" | "already_attested"; attestation: ByoSmsAttestationState }
  | Refusal
  | { ok: false; code: "no_number" | "gradia_number" | "not_own_account" | "number_changed" }
export type ByoSmsRevokeResult =
  | { ok: true; status: "revoked" | "already_revoked"; attestation: ByoSmsAttestationState }
  | Refusal

const conflicts = ["no_number", "gradia_number", "not_own_account", "number_changed"] as const

/** Maps a PostgREST error from the attestation functions to a stable result code. */
export function byoSmsRefusal(error: { code?: string; details?: string | null }): Extract<ByoSmsAttestResult, { ok: false }> {
  const detail = typeof error.details === "string" ? error.details : ""
  if (error.code === "42501") return { ok: false, code: "forbidden" }
  if (error.code === "22023" && detail === "statement_version") return { ok: false, code: "invalid", field: "statementVersion" }
  if (error.code === "PT409") {
    const conflict = conflicts.find((c) => c === detail)
    if (conflict) return { ok: false, code: conflict }
  }
  return { ok: false, code: "not_confirmed" }
}

/** Splits a state-plus-status response into the action result shape. */
export function splitStatus<S extends string>(data: ByoSmsAttestationState & { status: S }) {
  const { status, ...attestation } = data
  return { status, attestation }
}
