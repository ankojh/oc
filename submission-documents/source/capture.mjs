import {chromium} from '../../marketing/node_modules/playwright/index.mjs';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const folder=new URL('../screenshots/',import.meta.url),base='http://127.0.0.1:3103';
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
const context=await browser.newContext({viewport:{width:1440,height:1100},deviceScaleFactor:2});
const page=await context.newPage();
const path=n=>fileURLToPath(new URL(n+'.png',folder));
async function snap(selector,name){const l=page.locator(selector).first();await l.scrollIntoViewIfNeeded();await l.screenshot({path:path(name)});}
const notes=[];
try {
  try{await page.goto('https://www.opus.pro/',{waitUntil:'domcontentloaded',timeout:25000});await page.waitForTimeout(2500);await page.screenshot({path:path('current-homepage-hero'),clip:{x:0,y:0,width:1440,height:950}});notes.push('Current official homepage captured from opus.pro; no sign-in or account screen.');}catch(err){notes.push('Current homepage browser capture unavailable: '+err.message);}
  await page.goto(base);await page.evaluate(()=>document.fonts.ready);await page.locator('.question-button').first().waitFor();await page.waitForFunction(()=>!document.querySelector('input[value=fixture]').disabled);
  await page.screenshot({path:path('homepage-desktop'),fullPage:true});
  const bottom=await page.locator('.proof').boundingBox();await page.screenshot({path:path('hero-desktop'),clip:{x:0,y:0,width:1440,height:Math.ceil(bottom.y+bottom.height)}});
  await snap('#how-it-works','core-product');await snap('.audience-stage','audience-desktop');await snap('#teams','teams-detail');
  await snap('#hero-title','component-heading');await snap('.input-row','component-entry');await snap('.question-button[aria-pressed=true]','component-question');await snap('.portrait-frame','component-portrait');
  const stage=page.locator('.audience-stage');await page.locator('.question-button').nth(0).click();await page.waitForTimeout(650);await stage.screenshot({path:path('interaction-01-before')});
  await page.locator('.question-button').nth(1).click();await page.evaluate(()=>document.getAnimations().forEach(a=>{a.pause();a.currentTime=100;}));await stage.screenshot({path:path('interaction-02-highlight')});
  await page.evaluate(()=>document.getAnimations().forEach(a=>{a.currentTime=600;a.finish();}));await stage.screenshot({path:path('interaction-03-result')});
  await page.locator('.question-button').nth(0).click();await page.waitForTimeout(650);
  await page.locator('#video-url').fill('https://www.youtube.com/watch?v=FXdemo00001');await page.locator('[data-explore]').first().click();await page.locator('#coordinator-credit-ack').waitFor({timeout:20000});
  const id=new URL(page.url()).searchParams.get('id');const research=await fetch(`${base}/api/integrations/${id}`).then(r=>r.json());
  await snap('#workbench-results .wb-question:first-of-type','workbench-research-question');
  await page.locator('#coordinator-credit-ack').scrollIntoViewIfNeeded();await page.getByRole('button',{name:'Generate fixture clips'}).scrollIntoViewIfNeeded();
  const ack=await page.locator('.credit-confirm').boundingBox(),gen=await page.getByRole('button',{name:'Generate fixture clips'}).boundingBox();
  await page.screenshot({path:path('workbench-generate'),clip:{x:ack.x,y:ack.y,width:ack.width,height:gen.y+gen.height-ack.y+24}});
  // Explicit acknowledgment; synthetic fixture only, never live or paid.
  await page.locator('#coordinator-credit-ack').check();await page.getByRole('button',{name:'Generate fixture clips'}).click();await page.getByRole('button',{name:'Export reviewed evidence'}).waitFor({timeout:30000});
  await snap('#workbench-results .wb-question:first-of-type','workbench-review-question');
  const view=await fetch(`${base}/api/integrations/${id}`).then(r=>r.json());
  await writeFile(new URL('../source/capture-provenance.json',import.meta.url),JSON.stringify({capturedAt:new Date().toISOString(),viewport:{desktop:1440,mobile:390,density:2},mode:view.mode,integrationId:id,status:view.status,researchRunId:view.research.runId,reviewId:view.review.reviewId,sourceCoverage:view.handoff.sourceTranscript.coverage,questionIds:view.questions.map(q=>q.id),clipCount:view.clips.length,providerSubmitAttempts:view.generation.providerSubmitAttempts,judgment:'bound hand-authored synthetic reviewer fixture; not live output',notes},null,2)+'\n');
  await page.locator('#close-workbench').click();await page.setViewportSize({width:390,height:1100});await page.goto(base);await page.locator('.question-button').first().waitFor();await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:path('homepage-mobile'),fullPage:true});
  const copy=await page.locator('.hero-copy').boundingBox();await page.screenshot({path:path('hero-mobile'),clip:{x:0,y:0,width:390,height:Math.ceil(copy.y+copy.height+20)}});
  await snap('.evidence-column','audience-mobile-evidence');await snap('.clip-column','audience-mobile-clip');
  notes.push('Mobile evidence and clip captured in native single-column reading order.');
  console.log('Captured actual homepage, coherent synthetic research/review evidence, components and signature states.');
}finally{await browser.close();}
