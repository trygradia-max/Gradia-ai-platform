import {afterEach,describe,expect,it,vi} from 'vitest'
import {getEmailMessage,sendEmailMessage} from '@/lib/aurinko'
const input={to:'fictional@example.test',subject:'Fictional answer',body:'Synthetic reply',replyToMessageId:'provider-id_123='}
afterEach(()=>vi.unstubAllGlobals())
describe('provider-threaded email boundary',()=>{
 it('uses the exact reply endpoint, one explicit recipient and no inherited CC/BCC',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({status:'Ok',id:'sent-id',processingStatus:'Ok'})));vi.stubGlobal('fetch',fetcher)
  expect(await sendEmailMessage('synthetic-token',input)).toEqual({id:'sent-id'})
  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit]
  expect(url).toBe('https://api.aurinko.io/v1/email/messages/provider-id_123%3D/reply?bodyType=text&returnIds=true')
  expect(JSON.parse(init.body as string)).toEqual({to:[{address:input.to}],subject:input.subject,body:input.body,cc:[],bcc:[]})
 })
 it.each(['..','.','a/b','a?x','a#x','a%2fb','a\\b','a\n',''])('rejects unsupported reply identity %j before fetch',async id=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher)
  await expect(sendEmailMessage('synthetic-token',{...input,replyToMessageId:id})).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled()
 })
 it('rejects reply CC before transport',async()=>{const f=vi.fn();vi.stubGlobal('fetch',f);await expect(sendEmailMessage('synthetic-token',{...input,cc:'another@example.test'})).rejects.toThrow();expect(f).not.toHaveBeenCalled()})
 it.each([{status:'Ok',processingStatus:'Incomplete',id:'id'},{status:'Ok'},{status:'Error',id:'id'}])('holds uncertain response without standalone fallback: %j',async body=>{
  const f=vi.fn(async()=>new Response(JSON.stringify(body)));vi.stubGlobal('fetch',f);await expect(sendEmailMessage('synthetic-token',input)).rejects.toThrow();expect(f).toHaveBeenCalledTimes(1)
 })
 it('withholds raw provider errors',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response('private-provider-detail',{status:500})));await expect(sendEmailMessage('synthetic-token',input)).rejects.not.toThrow('private-provider-detail')})
 it('rejects a fetched message with a substituted ID',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({id:'different-id'}))));await expect(getEmailMessage('synthetic-token','expected-id')).rejects.toThrow()})
})
