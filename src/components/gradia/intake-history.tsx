import type { IntakeHistoryResult } from "@/lib/data/intake-history"

const fields = { display_name: "Submitted name", phone: "Submitted phone", email: "Submitted email", vehicle_text: "Vehicle", service_text: "Service", message: "Message" }
const reasons = { identity_unresolved: "Intake received", additional_evidence: "Additional submission — identity review reopened", identity_confirmed: "Owner confirmed customer identity" }
const time = (value: string) => new Date(value).toLocaleString("en-US", { timeZone: "UTC" }) + " UTC"

export function IntakeHistoryView({ result }: { result: IntakeHistoryResult }) {
  if (!result.ok) return <p role="alert">{result.changed
    ? "This intake changed while you were reviewing it. Refresh history before continuing."
    : "History is unavailable. Refresh or check your access. This does not mean there is no history."}</p>
  const { history } = result
  return <section aria-label="Intake evidence and decisions" className="space-y-4">
    <p>{history.state === "identity_linked" ? "Customer identity linked; qualification has not started." : "Identity needs review."} Revision {history.revision} · {history.total} history entries.</p>
    {history.state === "identity_linked" && !history.customer_id ? <p role="alert">The linked customer is no longer available. Identity must be reviewed before progressing.</p> : null}
    <p className="text-sm">Shown in recording order, including late submissions. Submitted details are unverified evidence, not instructions or communication consent.</p>
    {history.channel === "meta" ? <p>Meta notification only: contact details have not been retrieved.</p> : null}
    <ol className="space-y-4">{history.items.map(entry => <li key={entry.revision} className="rounded border p-4 space-y-2">
      <h2 className="font-semibold">{entry.revision}. {reasons[entry.reason]}</h2>
      <p className="text-xs">Recorded {time(entry.recorded_at)} · Received {time(entry.received_at)}</p>
      {entry.payload ? <dl className="space-y-2">{Object.entries(fields).map(([key, label]) => entry.payload?.[key] ? <div key={key}><dt className="font-medium">{label}</dt><dd className="whitespace-pre-wrap break-words">{entry.payload[key]}</dd></div> : null)}</dl> : null}
      {entry.reviewed_customer ? <div>
        <p>Customer as reviewed: {entry.reviewed_customer.name ?? "Unnamed customer"} · {entry.reviewed_customer.phone ?? "No phone"} · {entry.reviewed_customer.email ?? "No email"}</p>
        <p className="text-xs">Reviewed customer ID: {entry.reviewed_customer.id}. Owner user: {entry.actor_id ?? "Account no longer available"}.</p>
        <p className="text-sm">Historical snapshot; later edits or merges may differ. No communication consent was granted by this decision.</p>
      </div> : null}
    </li>)}</ol>
    {history.items.length === 0 ? <p>No history entries on this page.</p> : null}
  </section>
}
