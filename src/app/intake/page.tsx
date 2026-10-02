import Link from "next/link"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { TeamWorkspace } from "@/lib/team-permissions"
import { loadIntakeReview } from "@/lib/data/intake-review"
import { IntakeReviewQueue } from "@/components/gradia/intake-review-queue"
export const dynamic="force-dynamic"
export default async function IntakePage({searchParams}:{searchParams:Promise<{shop?:string;page?:string}>}){
 await requireUser()
 const db=await createClient(),params=await searchParams
 const workspaces=await db.rpc('team_workspaces')
 if(workspaces.error)throw new Error('Workspace access could not be verified.')
 const allowed=((workspaces.data??[]) as TeamWorkspace[]).filter(w=>w.role==='owner'||(w.role==='manager'&&w.capabilities.includes('crm.read')))
 const workspace=params.shop?allowed.find(w=>w.id===params.shop):allowed[0]
 const rawPage=Number(params.page??'1'),page=Number.isSafeInteger(rawPage)&&rawPage>0&&rawPage<100000?rawPage:1
 if(!workspace)return <main className="mx-auto max-w-3xl space-y-4 p-6"><h1 className="text-2xl font-semibold">Intake review</h1><p>This shop’s intake is not available to your account.</p><Link href="/team" className="underline">Back to your workspaces</Link></main>
 const result=await loadIntakeReview(db,workspace.id,(page-1)*20)
 return <main className="mx-auto max-w-3xl space-y-6 p-6"><Link href="/team" className="underline">Your workspaces</Link><h1 className="text-2xl font-semibold">{workspace.name} · Intake review</h1>
 <nav aria-label="Intake workspaces" className="flex flex-wrap gap-4">{allowed.map(w=><Link key={w.id} href={`/intake?shop=${w.id}`} className="underline">{w.name}</Link>)}</nav>
 <IntakeReviewQueue result={result} shopId={workspace.id}/>
 <nav aria-label="Intake pages" className="flex gap-4">{page>1?<Link href={`/intake?shop=${workspace.id}&page=${page-1}`} className="underline">Previous</Link>:null}{result.ok&&page*20<result.queue.total?<Link href={`/intake?shop=${workspace.id}&page=${page+1}`} className="underline">Next</Link>:null}</nav></main>
}
