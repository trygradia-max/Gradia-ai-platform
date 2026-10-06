import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import type {SupabaseClient} from '@supabase/supabase-js'
import {deliverManagerNotification} from '@/lib/manager-notification-delivery'
import {INTEGRATION_WITH_SESSION,serviceClient,ownerSessionClient,seedShop,anonClient,cleanup,type Seeded} from './_db'
describe.skipIf(!INTEGRATION_WITH_SESSION)('durable manager notifications',()=>{
 let db:SupabaseClient,owner:SupabaseClient,foreign:SupabaseClient,other:Seeded,shop:Seeded
 const sender='gradia@example.test'
 beforeAll(async()=>{db=serviceClient();const password=randomUUID();other=await seedShop(db,{password});foreign=await ownerSessionClient(other.email,password)})
 beforeEach(async()=>{const password=randomUUID();shop=await seedShop(db,{password});owner=await ownerSessionClient(shop.email,password)})
 afterEach(async()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();await cleanup(db,shop)})
 afterAll(async()=>{await cleanup(db,other)})
 const configure=(patch:Record<string,unknown>={},client=owner)=>client.rpc('configure_manager_notifications',{p_shop:shop.shopId,p_revision:0,p_mode:'immediate',p_timezone:'UTC',p_quiet_start:0,p_quiet_end:0,p_digest_hour:0,...patch})
 const claim=(client=db)=>client.rpc('claim_manager_notification',{p_shop:shop.shopId,p_sender:sender})
 const finish=(id:string,outcome:string,attempt=1)=>db.rpc('finish_manager_notification',{p_shop:shop.shopId,p_id:id,p_attempt:attempt,p_outcome:outcome,p_provider_id:outcome==='accepted'?'synthetic-provider-id':null})
 const history=async()=>{const r=await owner.rpc('read_manager_notifications',{p_shop:shop.shopId});expect(r.error).toBeNull();return r.data.history as Array<{id:string;state:string;item_count:number;attempts:number}>}
 async function event(assignee:string|null=null){
  const c=await db.from('customers').insert({shop_id:shop.shopId,name:'Fictional notification customer'}).select('id').single();expect(c.error).toBeNull()
  const i=await db.from('interactions').insert({shop_id:shop.shopId,customer_id:c.data!.id,channel:'sms',role:'customer',content:'Fictional private message, never in email'}).select('id').single();expect(i.error).toBeNull()
  const args={p_shop:shop.shopId,p_customer:c.data!.id,p_channel:'sms',p_command:randomUUID(),p_latest:i.data!.id,p_revision:0,p_operation:'handoff',p_payload:{state:'held',reason:'Fictional review needed',assignee_id:assignee}}
  expect((await owner.rpc('whisper_command',args)).error).toBeNull();return args
 }
 async function manager(){
  const email=`notification-${randomUUID()}@example.test`,password=randomUUID(),u=await db.auth.admin.createUser({email,password,email_confirm:true});expect(u.error).toBeNull()
  const session=await ownerSessionClient(email,password),invite=await owner.rpc('team_invite',{p_shop:shop.shopId,p_email:email,p_name:'Fictional Manager',p_role:'manager',p_capabilities:['crm.read']});expect(invite.error).toBeNull();expect((await session.rpc('team_accept_invite',{p_token:invite.data.token})).error).toBeNull()
  const m=await db.from('shop_memberships').select('id').eq('shop_id',shop.shopId).eq('user_id',u.data.user!.id).single();expect(m.error).toBeNull()
  return {id:m.data!.id,user:u.data.user!.id,session,email}
 }
 it('defaults off, exposes no private email and does not send historical notifications on initial enable',async()=>{
  expect((await owner.rpc('read_manager_notifications',{p_shop:shop.shopId})).data.settings.mode).toBe('off')
  await event();expect((await claim()).data).toBeNull();expect((await configure()).error).toBeNull();expect((await claim()).data).toBeNull()
  await event();const job=await claim();expect(job.error).toBeNull();expect(job.data.recipient_email).toBe(shop.email);expect(job.data.body).not.toContain('Fictional private');expect(JSON.stringify(await history())).not.toContain(shop.email)
 })
 it('owner-only revision-checked preferences and inaccessible direct tables',async()=>{
  for(const c of [foreign,anonClient(),db])expect((await configure({},c)).error).not.toBeNull()
  expect((await configure()).data).toBe(1);expect((await configure()).error?.code).toBe('PT409')
  expect((await configure({p_revision:1,p_timezone:'Unknown/Place'})).error?.code).toBe('22023')
  for(const c of [owner,foreign,anonClient(),db])for(const table of ['manager_notification_settings','manager_notification_settings_audit','manager_notification_deliveries','manager_notification_items'])expect((await c.from(table).select('*')).error).not.toBeNull()
  expect((await claim(owner)).error).not.toBeNull();expect((await foreign.rpc('read_manager_notifications',{p_shop:shop.shopId})).error).not.toBeNull()
 })
 it('concurrent workers produce one provider call and completed work cannot resend',async()=>{
  await configure();await event();vi.stubEnv('GRADIA_MANAGER_EMAIL_DELIVERY','enabled');vi.stubEnv('GRADIA_NOTIFICATION_PROVIDER','resend');vi.stubEnv('GRADIA_NOTIFICATION_FROM',sender);vi.stubEnv('GRADIA_NOTIFICATION_API_KEY','synthetic-only')
  const f=vi.fn(async()=>new Response('{"id":"synthetic"}'));vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{if(String(input)==='https://api.resend.com/emails')return f();return realFetch(input,init)})
  const r=await Promise.all([deliverManagerNotification(db,shop.shopId),deliverManagerNotification(serviceClient(),shop.shopId)]);expect(r.sort()).toEqual(['accepted','idle']);expect(f).toHaveBeenCalledTimes(1)
  expect(await deliverManagerNotification(db,shop.shopId)).toBe('idle');expect(f).toHaveBeenCalledTimes(1);expect(await history()).toMatchObject([{state:'accepted',attempts:1}])
 })
 const realFetch=globalThis.fetch
 it('quiet hours hold; digest groups unread updates and permits one batch per recipient/day',async()=>{
  const hour=new Date().getUTCHours();expect((await configure({p_mode:'digest',p_quiet_start:hour,p_quiet_end:(hour+1)%24})).error).toBeNull();await event();await event()
  expect((await claim()).data).toBeNull();await configure({p_revision:1,p_mode:'digest'});const job=(await claim()).data;expect(job.item_count).toBe(2);await finish(job.id,'accepted');await event();expect((await claim()).data).toBeNull()
 })
 it('acknowledged work is not emailed',async()=>{
  await configure();const e=await event();expect((await owner.rpc('whisper_command',{...e,p_command:randomUUID(),p_revision:1,p_operation:'read',p_payload:{}})).error).toBeNull();expect((await claim()).data).toBeNull()
 })
 it('manager destination is current confirmed membership; revocation excludes queued work',async()=>{
  await configure();const m=await manager();try{
   expect((await configure({p_revision:1},m.session)).error).not.toBeNull();await event(m.id);const job=(await claim()).data;expect(job.recipient_email).toBe(m.email);await finish(job.id,'retry')
   expect((await db.from('shop_memberships').update({active:false}).eq('id',m.id)).error).toBeNull();await db.rpc('test_notification_clock',{p_id:job.id,p_mode:'due'});expect((await claim()).data).toBeNull();expect(await history()).toMatchObject([{state:'cancelled'}])
  }finally{await db.auth.admin.deleteUser(m.user)}
 })
 it('explicit throttling retries the same frozen payload at most three times',async()=>{
  await configure();await event();const first=(await claim()).data;expect(first).toBeTruthy()
  for(let attempt=1;attempt<=3;attempt++){
   expect((await finish(first.id,'retry',attempt)).data).toBe(true);expect((await claim()).data).toBeNull()
   if(attempt<3){expect((await db.rpc('test_notification_clock',{p_id:first.id,p_mode:'due'})).error).toBeNull();const next=(await claim()).data;expect(next).toMatchObject({id:first.id,body:first.body,recipient_email:first.recipient_email,attempts:attempt+1})}
  }
  expect(await history()).toMatchObject([{state:'failed',attempts:3}]);expect((await claim()).data).toBeNull()
 })
 it.each(['unknown','stale','expired','acknowledged','settings'])('holds or cancels %s without automatic resend',async mode=>{
  await configure();const e=await event(),job=(await claim()).data
  if(mode==='unknown')await finish(job.id,'unknown')
  else if(mode==='stale')await db.rpc('test_notification_clock',{p_id:job.id,p_mode:'stale'})
  else{
   await finish(job.id,'retry');await db.rpc('test_notification_clock',{p_id:job.id,p_mode:mode==='expired'?'expired':'due'})
   if(mode==='acknowledged')await owner.rpc('whisper_command',{...e,p_command:randomUUID(),p_revision:1,p_operation:'read',p_payload:{}})
   if(mode==='settings')await configure({p_revision:1,p_mode:'digest'})
  }
  expect((await claim()).data).toBeNull();expect(await history()).toMatchObject([{state:['unknown','stale'].includes(mode)?'unknown':'cancelled'}]);expect((await finish(job.id,'accepted')).data).toBe(false)
 })
})
