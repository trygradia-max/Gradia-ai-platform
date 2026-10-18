"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"

import {
  attestByoSmsRegistration,
  revokeByoSmsRegistration,
} from "@/app/actions/byo-sms-attestation"
import { Button } from "@/components/ui/button"
import {
  BYO_SMS_ATTESTATION_STATEMENT,
  BYO_SMS_ATTESTATION_STATEMENT_VERSION,
  byoSmsSetupStatus,
  type ByoSmsAttestationState,
} from "@/lib/byo-sms-attestation"

function refusalCopy(code: string): string {
  switch (code) {
    case "uncertain":
      return "That did not save. Try again."
    case "forbidden":
      return "Only the business owner can confirm this."
    case "number_changed":
      return "The number changed. Review it and confirm again."
    case "not_own_account":
      return "Connect your own account before confirming texting."
    case "no_number":
      return "Add a number before confirming texting."
    case "gradia_number":
      return "This number uses carrier registration instead."
    default:
      return "That confirmation was not saved. Try again."
  }
}

/**
 * Owner attestation for a bring-your-own number. Confirmed is Ready to test.
 * A Gradia number has no attestation here.
 */
export function ByoSmsAttestationCard({
  shopId,
  initial,
}: {
  shopId: string
  initial: ByoSmsAttestationState
}) {
  const [state, setState] = React.useState(initial)
  const [checked, setChecked] = React.useState(false)
  const [pending, setPending] = React.useState<"attest" | "revoke" | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const status = byoSmsSetupStatus(state.state)

  if (state.state === "no_number" || state.state === "gradia_number" || status === null) {
    return null
  }

  async function confirm() {
    if (pending || !state.phone_e164) return
    setPending("attest")
    setError(null)
    const result = await attestByoSmsRegistration({
      shopId,
      phoneE164: state.phone_e164,
      statementVersion: BYO_SMS_ATTESTATION_STATEMENT_VERSION,
      confirm: true,
    })
    setPending(null)
    if (!result.ok) {
      setError(refusalCopy(result.code))
      return
    }
    setState(result.attestation)
    setChecked(false)
  }

  async function withdraw() {
    if (pending) return
    setPending("revoke")
    setError(null)
    const result = await revokeByoSmsRegistration({ shopId })
    setPending(null)
    if (!result.ok) {
      setError(refusalCopy(result.code))
      return
    }
    setState(result.attestation)
  }

  const confirmed = state.state === "confirmed"

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-muted/15 px-3.5 py-3">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Texting on your number
        </p>
        <p className="mt-1 text-sm font-medium text-foreground">{status}</p>
        {state.phone_e164 ? (
          <p className="mt-1 text-sm tabular-nums text-foreground">{state.phone_e164}</p>
        ) : null}
      </div>
      {confirmed ? (
        <p className="text-sm text-muted-foreground">
          You confirmed this number&apos;s texting registration. Send a test before relying on it.
        </p>
      ) : state.state === "not_own_account" ? (
        <p className="text-sm text-muted-foreground">
          This number is not on an account you connected. Texting stays held.
        </p>
      ) : (
        <label htmlFor="byo-sms-confirm" className="flex items-start gap-3 text-sm text-foreground">
          <input
            id="byo-sms-confirm"
            type="checkbox"
            className="mt-1 size-4 accent-primary"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          <span>{BYO_SMS_ATTESTATION_STATEMENT}</span>
        </label>
      )}
      {error ? (
        <p role="alert" className="text-sm text-status-danger-fg">
          {error}
        </p>
      ) : null}
      {confirmed ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => void withdraw()}
          disabled={pending !== null}
        >
          {pending === "revoke" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Withdraw confirmation
        </Button>
      ) : state.state === "unconfirmed" ? (
        <Button
          type="button"
          className="min-h-11"
          onClick={() => void confirm()}
          disabled={pending !== null || !checked || !state.phone_e164}
        >
          {pending === "attest" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Confirm texting registration
        </Button>
      ) : null}
    </div>
  )
}
