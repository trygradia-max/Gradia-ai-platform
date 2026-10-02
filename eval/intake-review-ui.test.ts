import { describe,it,expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { IntakeReviewQueue } from '@/components/gradia/intake-review-queue'
const id='00000000-0000-4000-8000-000000000001'
describe('intake review presentation',()=>{
 it('escapes submitted text and explains unresolved identity without action buttons',()=>{
  const html=renderToStaticMarkup(createElement(IntakeReviewQueue,{shopId:id,result:{ok:true,queue:{total:1,items:[{id,channel:'website_form',provider:'website_form',state:'identity_review',revision:1,last_received_at:'2026-10-02T18:00:00Z',payload:{message:'<script>alert(1)</script>',phone:'+15555550111'}}]}}}))
  expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('Identity unresolved');expect(html).toContain('does not create a customer');expect(html).not.toContain('<button');expect(html).not.toContain('<form')
 })
 it('distinguishes failed loading from an empty queue',()=>{
  const html=renderToStaticMarkup(createElement(IntakeReviewQueue,{shopId:id,result:{ok:false}}))
  expect(html).toContain('role="alert"');expect(html).not.toContain('No unresolved intake.')
 })
 it('explains Meta missing contact details and links compact cards to the correct workspace',()=>{
  const html=renderToStaticMarkup(createElement(IntakeReviewQueue,{shopId:id,compact:true,result:{ok:true,queue:{total:1,items:[{id,channel:'meta',provider:'meta_lead_ads',state:'identity_review',revision:1,last_received_at:'2026-10-02T18:00:00Z',payload:{leadgen_id:'secret-provider-id'}}]}}}))
  expect(html).toContain('Contact details have not been retrieved');expect(html).not.toContain('secret-provider-id');expect(html).toContain(`/intake?shop=${id}`)
 })
})
