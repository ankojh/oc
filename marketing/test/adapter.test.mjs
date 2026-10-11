import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {SampleProvider,UnavailableLiveProvider,isYouTubeUrl,safeMediaUrl,timecode,validateSample} from '../public/adapter.js';
const input=JSON.parse(await readFile(new URL('../public/sample-input.json',import.meta.url)));
const report=JSON.parse(await readFile(new URL('../public/sample-report.json',import.meta.url)));
const calls=[];
const fetcher=async path=>{calls.push(path);return new Response(JSON.stringify(path.includes('report')?report:input),{status:200});};
if(!globalThis.crypto)globalThis.crypto=webcrypto;
test('YouTube links validate precisely; arbitrary hosts and credential links do not',()=>{
  for(const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ','https://youtu.be/dQw4w9WgXcQ','https://youtube.com/shorts/dQw4w9WgXcQ','https://m.youtube.com/live/dQw4w9WgXcQ'])assert.equal(isYouTubeUrl(u),true,u);
  for(const u of ['http://youtube.com/watch?v=dQw4w9WgXcQ','https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ','not-a-url','https://youtu.be/no'])assert.equal(isYouTubeUrl(u),false,u);
});
test('fixture media is never treated as a working preview/export',()=>{
  for(const u of [null,'javascript:alert(1)','https://fixtures.invalid/x.mp4','https://localhost/x','http://example.com/x'])assert.equal(safeMediaUrl(u),null);
  assert.equal(safeMediaUrl('https://cdn.example.com/clip.mp4'),'https://cdn.example.com/clip.mp4');
});
test('sample comments/passages/recommendations belong to the immutable snapshot',()=>{
  assert.doesNotThrow(()=>validateSample(input,report));
  const changed=structuredClone(report);changed.matches[0].answerPassages[0].quote='invented';assert.throws(()=>validateSample(input,changed),/saved transcript/);
  const changedId=structuredClone(report);changedId.runId='other';assert.throws(()=>validateSample(input,changedId),/snapshot/);
});
test('sample flow preserves visitor URL, uses explicit acknowledgment and creates no provider job',async()=>{
  calls.length=0;const p=new SampleProvider(fetcher);let rec=await p.research('https://youtu.be/dQw4w9WgXcQ','Answers');assert.equal(rec.status,'research_ready');assert.equal(rec.videoUrl,'https://youtu.be/dQw4w9WgXcQ');
  await assert.rejects(()=>p.generate(rec,false),/Acknowledge/);rec=await p.generate(rec,true);rec=await p.review(rec);assert.equal(rec.status,'complete');assert.equal((await p.observe(rec.id)).id,rec.id);
  assert.deepEqual(calls,['/sample-input.json','/sample-input.json','/sample-report.json']);
  assert.equal(rec.input.clips.length,4);assert.equal(rec.input.clips[3].transcriptStatus,'unavailable');assert.equal(rec.report.unansweredQuestions[0].questionId,'q_3');
});
test('review retry loads only judgment, not generation',async()=>{calls.length=0;const p=new SampleProvider(fetcher);const rec={id:'retry',mode:'sample',status:'failed',failedStage:'review',videoUrl:input.research.video.url,goal:'',input};await p.retryReview(rec);assert.deepEqual(calls,['/sample-report.json']);});
test('insufficient research remains insufficient',async()=>{const low=structuredClone(input);low.research.researchStatus='insufficient_evidence';low.research.questions=[];const p=new SampleProvider(async()=>new Response(JSON.stringify(low)));assert.equal((await p.research(input.research.video.url,'')).status,'insufficient_evidence');});
test('missing sample response fails rather than silently using live',async()=>{const p=new SampleProvider(async()=>new Response('',{status:503}));await assert.rejects(()=>p.research(input.research.video.url,''),/offline sample/);});
test('live boundary remains unavailable for all operations',async()=>{const p=new UnavailableLiveProvider();assert.equal(p.available,false);for(const fn of [()=>p.research('x',''),()=>p.generate({},true),()=>p.review({}),()=>p.observe('x'),()=>p.retryReview({})])await assert.rejects(fn,/not connected/);});
test('source timecodes use integer millisecond evidence',()=>{assert.equal(timecode(245000),'04:05');assert.equal(timecode(575500),'09:35');});
