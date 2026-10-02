import Link from "next/link"
import { recordCommandSchema } from "@/lib/control-center/record-command"
export function RecordProposalDetails({type,payload}:{type:string;payload:Record<string,unknown>}){
 const clean={...payload};delete clean.source;delete clean.mcp_token_id
 const parsed=recordCommandSchema.safeParse({type,payload:clean})
 if(!parsed.success)return <p role="alert">This proposal is incomplete. Reject it and request a new one.</p>
 const c=parsed.data
 if(c.type==='update_customer')return <div className="space-y-3 text-sm">
  <p className="font-medium">Edit {c.payload.before.name??'customer'} · {c.payload.before.phone??c.payload.before.email??'contact on file'}</p>
  <dl className="space-y-2">{Object.entries(c.payload.changes).map(([key,value])=><div key={key}><dt className="font-medium capitalize">{key}</dt><dd>{c.payload.before[key as keyof typeof c.payload.before]??'Not set'} → {value}</dd></div>)}</dl>
  {c.payload.vehicle?<div><p className="font-medium">{c.payload.vehicle.id?'Update existing vehicle':'Add first vehicle'}</p>{Object.entries(c.payload.vehicle.changes).map(([k,v])=><p key={k} className="capitalize">{k}: {c.payload.vehicle?.before?.[k as keyof NonNullable<typeof c.payload.vehicle.before>]??'Not set'} → {v}</p>)}</div>:null}
  <p className="text-muted-foreground">If the record changes before approval, this proposal is held for a fresh review. Consent is not transferred to a new phone or email.</p>
 </div>
 if(c.type==='resolve_customer')return <div className="space-y-2 text-sm"><p className="font-medium">Resolve customer identity</p><p>{c.payload.name??'Name not supplied'}</p><p>{c.payload.phone??'No phone'} · {c.payload.email??'No email'}</p><p className="text-muted-foreground">Find one matching customer and fill missing details, or create a customer. Conflicting identities are held for review; records are never merged here.</p></div>
 return <div className="space-y-2 text-sm">{c.payload.customer_id?<Link className="underline" href={`/customers/${c.payload.customer_id}`}>View customer record</Link>:<p>Unlinked shop history</p>}<p className="font-medium">Reported {c.payload.channel} history · {c.payload.role}</p><p className="whitespace-pre-wrap">{c.payload.content}</p><p className="text-muted-foreground">Agent-reported history only. Approval does not establish verified inbound activity, delivery or communication consent. No message or embedding request is sent.</p></div>
}
