import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import type {SupabaseClient} from '@supabase/supabase-js'
import {deliverManagerNotification} from '@/lib/manager-notification-delivery'
import {sendManagerNotification} from '@/lib/notification-email-provider'
const shop='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002'
const job={id,shop_id:shop,sender_email:'gradia@example.test',recipient_email:'manager@example.test',subject:'Review work',body:'Fictional operational notification',attempts:1}
const client=(rpc:ReturnType<typeof vi.fn>)=>({rpc}) as unknown as SupabaseClient
beforeEach(()=>{vi.stubEnv('GRADIA_MANAGER_EMAIL_DELIVERY','enabled');vi.stubEnv('GRADIA_NOTIFICATION_PROVIDER','resend');vi.stubEnv('GRADIA_NOTIFICATION_FROM',job.sender_email);vi.stubEnv('GRADIA_NOTIFICATION_API_KEY','synthetic-manager-provider')})
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs()})
describe('manager delivery isolation',()=>{
 it.each(['GRADIA_MANAGER_EMAIL_DELIVERY','GRADIA_NOTIFICATION_PROVIDER','GRADIA_NOTIFICATION_FROM','GRADIA_NOTIFICATION_API_KEY'])('requires explicit %s before database or transport',async key=>{
  vi.stubEnv(key,'');const rpc=vi.fn(),f=vi.fn();vi.stubGlobal('fetch',f);expect(await deliverManagerNotification(client(rpc),shop)).toBe('disabled');expect(rpc).not.toHaveBeenCalled();expect(f).not.toHaveBeenCalled()
 })
 it.each([{data:null,error:{code:'synthetic'}},{data:{...job,shop_id:id},error:null},{data:{...job,sender_email:'other@example.test'},error:null},{data:{},error:null}])('claim failure or foreign job cannot send %j',async result=>{
  const f=vi.fn();vi.stubGlobal('fetch',f);expect(await deliverManagerNotification(client(vi.fn(async()=>result)),shop)).toBe('unavailable');expect(f).not.toHaveBeenCalled()
 })
 it('sends one immutable batch with an idempotency key, then records provider acceptance',async()=>{
  const rpc=vi.fn().mockResolvedValueOnce({data:job,error:null}).mockResolvedValueOnce({data:true,error:null}),f=vi.fn(async()=>new Response(JSON.stringify({id:'synthetic-accepted'})));vi.stubGlobal('fetch',f)
  expect(await deliverManagerNotification(client(rpc),shop)).toBe('accepted');expect(f).toHaveBeenCalledTimes(1)
  const [url,init]=f.mock.calls[0] as unknown as [string,RequestInit];expect(url).toBe('https://api.resend.com/emails');expect(init.headers).toMatchObject({'Idempotency-Key':`gradia-manager/${id}`});expect(JSON.parse(init.body as string)).toEqual({from:job.sender_email,to:[job.recipient_email],subject:job.subject,text:job.body})
  expect(rpc).toHaveBeenLastCalledWith('finish_manager_notification',{p_shop:shop,p_id:id,p_attempt:1,p_outcome:'accepted',p_provider_id:'synthetic-accepted'})
 })
 it.each([[429,'retry'],[400,'failed'],[401,'failed'],[408,'unknown'],[409,'unknown'],[500,'unknown'],[502,'unknown']])('HTTP %s yields %s with no internal resend',async(status,state)=>{
  const f=vi.fn(async()=>new Response('{}',{status:Number(status)}));vi.stubGlobal('fetch',f);expect(await sendManagerNotification(job)).toEqual({state,providerId:null});expect(f).toHaveBeenCalledTimes(1)
 })
 it('network uncertainty and invalid acceptance do not retry',async()=>{
  const f=vi.fn().mockRejectedValueOnce(new Error('synthetic')).mockResolvedValueOnce(new Response('{}'));vi.stubGlobal('fetch',f)
  expect((await sendManagerNotification(job)).state).toBe('unknown');expect((await sendManagerNotification(job)).state).toBe('unknown');expect(f).toHaveBeenCalledTimes(2)
 })
 it('failed completion stays unknown without another send',async()=>{
  const rpc=vi.fn().mockResolvedValueOnce({data:job,error:null}).mockResolvedValueOnce({data:false,error:null}),f=vi.fn(async()=>new Response('{"id":"synthetic"}'));vi.stubGlobal('fetch',f)
  expect(await deliverManagerNotification(client(rpc),shop)).toBe('unknown');expect(f).toHaveBeenCalledTimes(1)
 })
})
