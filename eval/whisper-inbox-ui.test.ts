import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {describe,it,expect,vi} from 'vitest'
import {WhisperInboxControls} from '@/components/gradia/whisper-inbox-controls'
import type {WhisperThread} from '@/lib/whisper-inbox'
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}))
vi.mock('@/app/actions/whisper-inbox',()=>({updateWhisperInbox:vi.fn()}))
const id='00000000-0000-4000-8000-000000000001'
const thread:WhisperThread={latest_id:id,revision:1,state:'held',reason:'Review',assignee_id:null,can_manage:true,can_reply:true,customer_id:id,channel:'sms',customer:{name:'Synthetic',phone:'+15550000000',email:'fictional@example.test'},items:[],members:[{id,name:'<script>private</script>'}],intakes:[],actions:[]}
const render=(patch:Partial<WhisperThread>={})=>renderToStaticMarkup(createElement(WhisperInboxControls,{shopId:id,thread:{...thread,...patch},commands:{read:id,handoff:id,reply:id}}))
describe('Whisper role-aware controls',()=>{
 it('assigned staff get read acknowledgement without management or reply controls',()=>{
  const html=render({can_manage:false,can_reply:false});expect(html).toContain('Mark read for me');expect(html).not.toContain('Save handoff');expect(html).not.toContain('Queue draft');expect(html).not.toContain('Responsible operator')
 })
 it('authorized managers get handoff controls without owner-only approval staging',()=>{
  const html=render({can_reply:false});expect(html).toContain('Save handoff');expect(html).not.toContain('Queue draft');expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>')
 })
 it('missing destinations and voice history cannot expose usable send controls',()=>{
  const html=render({customer:{...thread.customer,phone:null}});expect(html).toMatch(/<button disabled=""[^>]*>Queue draft in Approvals/);expect(render({channel:'voice'})).not.toContain('Queue draft')
 })
 it('email discloses approval and threading limitations rather than promising delivery',()=>{
  const html=render({channel:'email'});expect(html).toContain('Subject');expect(html).toContain('Marketing consent is required');expect(html).toContain('not yet a provider-threaded reply');expect(html).toContain('Completion does not mean a message was delivered')
 })
})
