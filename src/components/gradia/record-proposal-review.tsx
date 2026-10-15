"use client"
import { useState,useTransition } from "react"
import { useRouter } from "next/navigation"
import { approveFromDashboard,rejectFromDashboard } from "@/app/actions/approvals"
import { Button } from "@/components/ui/button"
import { RecordProposalDetails } from "./record-proposal-details"
export function RecordProposalReview({id,type,payload}:{id:string;type:string;payload:Record<string,unknown>}){
 const [busy,start]=useTransition(),[error,setError]=useState<string|null>(null),router=useRouter()
 function decide(approve:boolean){start(async()=>{
  setError(null)
  try{const result=await (approve?approveFromDashboard(id):rejectFromDashboard(id));if(!result.ok){setError(result.error);return}router.push('/approvals');router.refresh()}
  catch{setError('The result could not be verified. Check action history before retrying.')}
 })}
 return <section className="space-y-5 rounded-2xl border p-6"><RecordProposalDetails type={type} payload={payload}/><p className="text-sm text-muted-foreground">Review the proposed change. To change its details, reject it and request a fresh proposal.</p>{error?<p role="alert">{error}</p>:null}<div className="flex gap-3"><Button disabled={busy} onClick={()=>decide(true)}>Approve record change</Button><Button disabled={busy} variant="outline" onClick={()=>decide(false)}>Reject proposal</Button></div></section>
}
