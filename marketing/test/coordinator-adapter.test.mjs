import test from 'node:test';import assert from 'node:assert/strict';import {CoordinatorProvider} from '../public/coordinator-adapter.js';
test('real coordinator routes: research cannot silently generate; explicit Generate requires acknowledgment',async()=>{
  const calls=[];const fetcher=async(path,init)=>{calls.push({path,...init});return new Response(JSON.stringify({integration:{integrationId:'int_123',status:'researching'}}));};const p=new CoordinatorProvider(fetcher);
  await p.research('live','https://youtu.be/dQw4w9WgXcQ','Answer questions');assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/integrations');assert.equal(JSON.parse(calls[0].body).mode,'live');
  await assert.rejects(()=>p.generate('int_123',false),/Acknowledge/);assert.equal(calls.length,1);
  await p.generate('int_123',true);assert.equal(calls[1].path,'/api/integrations/int_123/generate');assert.deepEqual(JSON.parse(calls[1].body),{confirmCredits:true});
});
test('observation is GET-only and review recovery never generates',async()=>{
  const calls=[];const p=new CoordinatorProvider(async(path,init)=>{calls.push({path,...init});return new Response('{}');});await p.observe('int_123');await p.retryReview('int_123');await p.retryHandoff('int_123');await p.reconcile('int_123');await p.adopt('int_123','existing');
  assert.equal(calls[0].method,'GET');assert.deepEqual(calls.slice(1).map(c=>c.path),['/api/integrations/int_123/retry-review','/api/integrations/int_123/retry-handoff','/api/integrations/int_123/reconcile','/api/integrations/int_123/adopt-project']);assert.equal(typeof p.forceNewProject,'undefined');
});
