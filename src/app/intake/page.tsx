import { z } from "zod"
import { intakeCustomerSchema } from "@/lib/intake-identity"
import Link from "next/link"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { TeamWorkspace } from "@/lib/team-permissions"
import { loadIntakeReview } from "@/lib/data/intake-review"
import { IntakeReviewQueue } from "@/components/gradia/intake-review-queue"
export const dynamic="force-dynamic"
export default async function IntakePage({searchParams}:{searchParams:Promise<{shop?:string;page?:string;query?:string}>}){
 await requireUser()
 const db=await createClient(),params=await searchParams
 const workspaces=await db.rpc('team_workspaces')
 if(workspaces.error)throw new Error('Workspace access could not be verified.')
 const allowed=((workspaces.data??[]) as TeamWorkspace[]).filter(w=>w.role==='owner'||(w.role==='manager'&&w.capabilities.includes('crm.read')))
 const workspace=params.shop?allowed.find(w=>w.id===params.shop):allowed[0]
 const rawPage=Number(params.page??'1'),page=Number.isSafeInteger(rawPage)&&rawPage>0&&rawPage<100000?rawPage:1
 if(!workspace)return <main className="mx-auto max-w-3xl space-y-4 p-6"><h1 className="text-2xl font-semibold">Intake review</h1><p>This shop’s intake is not available to your account.</p><Link href="/team" className="underline">Back to your workspaces</Link></main>
 const query=typeof params.query==='string'?params.query.slice(0,100):''
 const candidates=workspace.role==='owner'?await db.rpc('search_intake_customers',{p_shop:workspace.id,p_query:query}):null
 const parsed=candidates&&!candidates.error?z.array(intakeCustomerSchema).safeParse(candidates.data):null
 const customers=parsed?.success?parsed.data:undefined
 const result=await loadIntakeReview(db,workspace.id,(page-1)*20)
 return <main className="mx-auto max-w-3xl space-y-6 p-6"><Link href="/team" className="underline">Your workspaces</Link><h1 className="text-2xl font-semibold">{workspace.name} · Intake review</h1>
 <nav aria-label="Intake workspaces" className="flex flex-wrap gap-4">{allowed.map(w=><Link key={w.id} href={`/intake?shop=${w.id}`} className="underline">{w.name}</Link>)}</nav>
 {workspace.role==='owner'?<form method="get" className="space-y-2"><input type="hidden" name="shop" value={workspace.id}/><label className="block">Find an existing customer for linking<input name="query" maxLength={100} defaultValue={query} className="ml-2 rounded border bg-background p-2" placeholder="Name, phone or email"/></label><button className="rounded border px-3 py-2">Search customers</button><p className="text-sm">Up to 20 matches. Searching does not select an identity. Create a genuinely new customer through the existing CRM first.</p>{!customers?<p role="alert">Customer choices could not be loaded. Linking is unavailable.</p>:null}</form>:<p>Identity linking currently requires the owner. Your read grant does not authorize changes.</p>}
 <IntakeReviewQueue result={result} shopId={workspace.id} customers={customers}/>
 <nav aria-label="Intake pages" className="flex gap-4">{page>1?<Link href={`/intake?shop=${workspace.id}&page=${page-1}`} className="underline">Previous</Link>:null}{result.ok&&page*20<result.queue.total?<Link href={`/intake?shop=${workspace.id}&page=${page+1}`} className="underline">Next</Link>:null}</nav></main>
}
