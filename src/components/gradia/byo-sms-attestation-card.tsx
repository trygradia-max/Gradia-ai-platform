"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { attestByoSmsRegistration, getByoSmsAttestation, revokeByoSmsRegistration } from "@/app/actions/byo-sms-attestation"
import { BYO_SMS_ATTESTATION_STATEMENT, BYO_SMS_ATTESTATION_STATEMENT_VERSION, byoSmsSetupStatus, type ByoSmsReadResult } from "@/lib/byo-sms-attestation"
import { Button } from "@/components/ui/button"

export function ByoSmsAttestationCard({ shopId, initial }: { shopId: string; initial: ByoSmsReadResult }) {
  const router = useRouter()
  const [result, setResult] = React.useState(initial)
  const [confirmed, setConfirmed] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const busy = React.useRef(false)
  const state = result.ok ? result.attestation : null

  async function change(revoke: boolean) {
    if (busy.current || !state?.phone_e164) return
    if (!revoke && (!confirmed || state.current_statement_version !== BYO_SMS_ATTESTATION_STATEMENT_VERSION)) return
    busy.current = true; setPending(true); setError(null)
    try {
      const response = revoke ? await revokeByoSmsRegistration({ shopId }) : await attestByoSmsRegistration({ shopId, phoneE164: state.phone_e164, statementVersion: BYO_SMS_ATTESTATION_STATEMENT_VERSION, confirm: true })
      setConfirmed(false)
      if (response.ok) {
        setResult({ ok: true, attestation: response.attestation })
        router.refresh()
      } else {
        // A refusal or lost result may mean the number/account changed. Re-read before allowing another confirmation.
        setResult({ ok: false, code: "uncertain" })
        const fresh = await getByoSmsAttestation({ shopId })
        setResult(fresh)
        setError("Confirmation was not completed. Review the current number and try again, or refresh the page.")
      }
    } catch {
      setResult({ ok: false, code: "uncertain" })
      setError("Could not confirm the saved state. Refresh before trying again.")
    } finally { busy.current = false; setPending(false) }
  }

  if (state?.state === "gradia_number" || state?.state === "no_number") return null
  return <section aria-label="Own Twilio number confirmation" className="space-y-3 rounded-lg border border-border p-4">
    <h3 className="font-medium">Using your own Twilio account</h3>
    {!state ? <p role="alert" className="text-sm text-muted-foreground">Own-number confirmation could not be loaded. Refresh or ask the business owner to review it.</p> : <>
      <p className="text-sm font-medium">{byoSmsSetupStatus(state.state)} · {state.phone_e164}</p>
      {state.state === "not_own_account" ? <p className="text-sm text-muted-foreground">Connect your own Twilio account above, or get a Gradia number. Texting stays held until setup is complete.</p> : state.state === "confirmed" ? <>
        <p className="text-sm text-muted-foreground">You confirmed this number&apos;s registration. Gradia has not verified it with the carrier. Consent and approval rules still apply.</p>
        <Button type="button" variant="outline" disabled={pending} onClick={() => void change(true)} className="min-h-11">Withdraw confirmation</Button>
      </> : <>
        <label htmlFor="byo-sms-confirm" className="flex min-h-11 items-start gap-3 text-sm">
          <input id="byo-sms-confirm" type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" checked={confirmed} disabled={pending} onChange={e => setConfirmed(e.target.checked)} />
          <span>{BYO_SMS_ATTESTATION_STATEMENT}</span>
        </label>
        <Button type="button" disabled={pending || !confirmed || state.current_statement_version !== BYO_SMS_ATTESTATION_STATEMENT_VERSION} onClick={() => void change(false)} className="min-h-11">Confirm texting registration</Button>
      </>}
    </>}
    {error ? <p role="alert" className="text-sm text-status-danger-fg">{error}</p> : null}
  </section>
}
