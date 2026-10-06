'use client'
import {useState,useTransition} from 'react'
import {useRouter} from 'next/navigation'
import {saveManagerNotifications} from '@/app/actions/manager-notifications'
import type {ManagerNotificationRead} from '@/lib/manager-notification-settings'
export function ManagerNotificationSettings({initial}:{initial:ManagerNotificationRead|null}){
 const router=useRouter(),[pending,startTransition]=useTransition(),[submitted,setSubmitted]=useState(false),[message,setMessage]=useState('')
 const [values,setValues]=useState(initial?.settings)
 if(!initial||!values)return <p role="alert">Manager notification preferences are unavailable. No changes can be saved.</p>
 const hours=[['quiet_start','Quiet hours start'],['quiet_end','Quiet hours end'],['digest_hour','Daily digest hour']] as const
 return <section className="mt-6 space-y-4 rounded border p-5" aria-label="Manager notifications">
  <h2 className="text-lg font-semibold">Manager notifications</h2>
  <p>Notify the assigned eligible manager or owner through independent email, never the customer mailbox. Delivery is not scheduled or activated by saving these preferences.</p>
  <form className="space-y-3" onSubmit={event=>{event.preventDefault();if(pending||submitted)return;setSubmitted(true);startTransition(async()=>{try{const r=await saveManagerNotifications(values);setMessage(r.message);if(r.ok)router.refresh()}catch{setMessage('Result uncertain. Refresh before trying again.')}})}}>
   <label className="block" htmlFor="manager-email-mode">Email mode</label>
   <select id="manager-email-mode" value={values.mode} disabled={pending||submitted} onChange={e=>setValues({...values,mode:e.target.value as typeof values.mode})}>
    <option value="off">Off</option><option value="immediate">Immediate, outside quiet hours</option><option value="digest">Daily digest</option>
   </select>
   <label className="block" htmlFor="manager-email-timezone">Timezone</label>
   <input id="manager-email-timezone" className="rounded border p-2" value={values.timezone} disabled={pending||submitted} onChange={e=>setValues({...values,timezone:e.target.value})}/>
   {hours.map(([key,label])=><div key={key}><label htmlFor={`manager-${key}`}>{label} (0–23)</label><input id={`manager-${key}`} type="number" min={0} max={23} className="ml-2 w-20 rounded border p-2" value={values[key]} disabled={pending||submitted} onChange={e=>setValues({...values,[key]:Number(e.target.value)})}/></div>)}
   <p>Equal start/end disables quiet hours. Digests wait until the chosen hour and outside quiet hours. Only new handoffs after initial setup are eligible. Notifications contain a workspace link, not customer message content.</p>
   <button type="submit" className="rounded border px-4 py-2" disabled={pending||submitted}>Save notification preferences</button>
   {message&&<p role="status">{message}</p>}
   {submitted&&<p>Refresh to inspect saved preferences before another change.</p>}
  </form>
  <h3 className="font-semibold">Recent delivery attempts</h3>
  <p>Accepted means the provider accepted the request, not confirmed delivery. Unknown outcomes stay held and never automatically resend.</p>
  {initial.history.length===0?<p>No email delivery attempts.</p>:<ul>{initial.history.map(d=><li key={d.id}>{d.recipient}: {d.state} · {d.item_count} updates · attempt {d.attempts} · {d.created_at}{d.reason?` · ${d.reason}`:''}</li>)}</ul>}
 </section>
}
