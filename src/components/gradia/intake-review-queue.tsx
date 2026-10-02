import { randomUUID } from "node:crypto"
import type { IntakeCustomer } from "@/lib/intake-identity"
import { IntakeIdentityForm } from "./intake-identity-form"
import Link from "next/link"
import type { IntakeReviewResult } from "@/lib/data/intake-review"
const channels={sms:"SMS",website_form:"Website form",meta:"Meta lead notification",synthetic:"Test intake"}
const fields={display_name:"Submitted name",phone:"Submitted phone",email:"Submitted email",vehicle_text:"Vehicle",service_text:"Service",message:"Message"}
export function IntakeReviewQueue({result,shopId,compact=false,customers}:{result:IntakeReviewResult;shopId:string;compact?:boolean;customers?:IntakeCustomer[]}){
  return <section aria-label="Unresolved intake" className="space-y-4">
    <h2 className="text-xl font-semibold">Intake needing identity review</h2>
    {!result.ok?<p role="alert">Intake could not be loaded. Refresh or ask the owner to check your access. This does not mean the queue is empty.</p>:<>
      <p className="text-sm text-muted-foreground">{result.queue.total} unresolved {result.queue.total===1?'item':'items'}. Submitted details are unverified; viewing them does not create a customer or grant communication consent.</p>
      {result.queue.items.length===0?<p>{result.queue.total===0?'No unresolved intake.':'No items on this page.'}</p>:<ul className="space-y-3">{result.queue.items.map(item=><li key={item.id} className="rounded-xl border bg-card p-4 space-y-2">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-medium">{channels[item.channel]}</h3><span className="text-sm">Identity unresolved</span></div>
        <p className="text-xs text-muted-foreground">Received {new Date(item.last_received_at).toLocaleString('en-US',{timeZone:'UTC'})} UTC · {item.event_count} recorded {item.event_count===1?'event':'events'}</p>
        <details><summary className="cursor-pointer text-sm underline">View latest submitted details</summary><dl className="mt-3 space-y-2 text-sm">{Object.entries(fields).map(([key,label])=>item.payload[key]?<div key={key}><dt className="font-medium">{label}</dt><dd className="whitespace-pre-wrap break-words">{item.payload[key]}</dd></div>:null)}</dl>
          {item.channel==='meta'?<p className="mt-2 text-sm">Only notification identifiers have been received. Contact details have not been retrieved from Meta.</p>:null}
          <p className="mt-3 text-sm text-muted-foreground">Identity linking is available to the owner in the full intake queue; dismissal is not available. Any existing customer or conversation record must be checked separately; matching contact text is not proof of identity.</p>
        </details>
        <Link className="block text-sm underline" href={`/intake/${item.id}?shop=${shopId}`}>Review full submission and decision history</Link>
        {!compact&&customers?<IntakeIdentityForm shopId={shopId} workflowId={item.id} revision={item.revision} commandId={randomUUID()} customers={customers}/>:null}
      </li>)}</ul>}
    </>}
    {compact?<Link className="text-sm underline" href={`/intake?shop=${shopId}`}>Open intake review queue</Link>:null}
  </section>
}
