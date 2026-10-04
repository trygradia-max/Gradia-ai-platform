'use client'
import { useState,useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import type { IntakeCustomer } from '@/lib/intake-identity'
import { linkIntakeIdentity } from '@/app/actions/intake-identity'
export function IntakeIdentityForm({shopId,workflowId,revision,commandId,customers}:{shopId:string;workflowId:string;revision:number;commandId:string;customers:IntakeCustomer[]}){
 const [selected,setSelected]=useState(''),[confirmed,setConfirmed]=useState(false),[message,setMessage]=useState(''),[busy,start]=useTransition(),router=useRouter()
 const customer=customers.find(c=>c.id===selected)
 return <form className="mt-4 space-y-3 border-t pt-3" onSubmit={e=>{e.preventDefault();if(!customer||!confirmed)return;start(async()=>{
  try{const result=await linkIntakeIdentity({shopId,workflowId,revision,commandId,customer,confirmed});setMessage(result.message);if(result.ok){toast.success(result.message);router.push(`/intake/${workflowId}?shop=${shopId}`)}}
  catch{setMessage('Result uncertain. Refresh the queue before retrying.')}
 })}}>
 <label className="block text-sm">Link to an existing customer<select aria-label="Existing customer" className="mt-1 block w-full rounded border bg-background p-2" value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setConfirmed(false)}}><option value="">Choose explicitly — no automatic match</option>{customers.map(c=><option key={c.id} value={c.id}>{c.name??'Unnamed customer'} · {c.phone??'No phone'} · {c.email??'No email'}</option>)}</select></label>
 <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={!customer||busy} onChange={e=>setConfirmed(e.target.checked)}/>I checked the submitted information and confirm this is the selected customer. This does not grant communication consent.</label>
 <button className="rounded border px-3 py-2 text-sm disabled:opacity-50" disabled={!customer||!confirmed||busy}>{busy?'Recording…':'Confirm identity link'}</button>
 {message?<p role="status" className="text-sm">{message}</p>:null}
 </form>
}
