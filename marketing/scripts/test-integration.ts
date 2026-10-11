// Real fixture HTTP/browser test in temporary data directories. No paid/live run.
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startServer as startReview} from '../../clip-review/src/server.ts';
import {startIntegrationServer} from '../../integration/src/server.ts';
import {startServer as startMarketing} from '../server.mjs';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const dir=await mkdtemp(join(tmpdir(),'opus-marketing-e2e-'));
const free=createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const researchPort=(free.address() as any).port;await new Promise<void>(r=>free.close(()=>r()));
const research=spawn(join(root,'audience-research/node_modules/.bin/tsx'),['src/server.ts'],{cwd:join(root,'audience-research'),env:{...process.env,PORT:String(researchPort),DATA_DIR:join(dir,'research'),YOUTUBE_API_KEY:'',OPUSCLIP_API_KEY:''},stdio:'ignore'});
const reviewer=startReview({port:0,dataDir:join(dir,'review'),backend:'fixture',makeCodex:()=>{throw Error('No live Codex permitted in marketing fixture verification');}});await once(reviewer,'listening');
const integration=startIntegrationServer({port:0,dataDir:join(dir,'integration'),researchUrl:`http://127.0.0.1:${researchPort}`,reviewUrl:`http://127.0.0.1:${(reviewer.address() as any).port}`,tickMs:100});const integrationBase=await integration.ready;
const marketing=startMarketing(0,integrationBase);await once(marketing,'listening');const base=`http://127.0.0.1:${(marketing.address() as any).port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
try{
  for(let i=0;i<60;i++){if(await fetch(`http://127.0.0.1:${researchPort}/health`).then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,100));}
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForFunction(()=>!document.querySelector<HTMLInputElement>('input[value=fixture]')?.disabled);
  await page.locator('#video-url').fill('https://youtu.be/dQw4w9WgXcQ');await page.locator('[data-explore]').first().click();
  await page.locator('#coordinator-credit-ack').waitFor();assert.equal(await page.locator('#workbench-url').inputValue(),'https://youtu.be/dQw4w9WgXcQ');
  assert.match(await page.locator('#workbench-results').textContent() || '',/has not been researched/);
  assert.equal(await page.getByRole('button',{name:'Generate fixture clips'}).isDisabled(),true);
  await page.screenshot({path:join(root,'marketing/deliverables/screenshots/integrated-research-desktop.png'),fullPage:true});
  await page.locator('#coordinator-credit-ack').check();await page.getByRole('button',{name:'Generate fixture clips'}).click();
  await page.getByRole('button',{name:'Export reviewed evidence'}).waitFor({timeout:25000});
  const id=new URL(page.url()).searchParams.get('id');assert.ok(id);
  const view=await fetch(`${base}/api/integrations/${id}`).then(r=>r.json());assert.equal(view.status,'complete');assert.equal(view.generation.providerSubmitAttempts,1);assert.equal(view.clips.length,4);assert.equal(view.clips[3].verifiable,false);assert.equal(view.handoff.sourceTranscript.coverage,'partial');
  assert.match(await page.locator('#workbench-results').textContent() || '',/No recommended clip/);
  await page.screenshot({path:join(root,'marketing/deliverables/screenshots/integrated-review-desktop.png'),fullPage:true});
  await page.reload();await page.getByRole('button',{name:'Export reviewed evidence'}).waitFor();const refreshed=await fetch(`${base}/api/integrations/${id}`).then(r=>r.json());assert.equal(refreshed.generation.providerSubmitAttempts,1);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(root,'marketing/deliverables/screenshots/integrated-review-mobile.png'),fullPage:true});assert(await page.evaluate(()=>document.querySelector('dialog')!.scrollWidth<=innerWidth));
  assert.equal(errors.length,0);
  await writeFile(join(root,'marketing/deliverables/integration-verification.json'),JSON.stringify({label:'Real service HTTP fixture + browser. Synthetic comments/media/judgment; no live integration.',status:view.status,providerSubmitAttempts:view.generation.providerSubmitAttempts,clipCount:view.clips.length,unverifiableClipRetained:true,sourceCoverage:view.handoff.sourceTranscript.coverage,refreshPreservesJob:true,browserErrors:errors},null,2)+'\n');
  console.log('Real fixture coordinator flow verified through the redesigned workbench; provider submission count stays one after refresh.');
}finally{
  await browser.close();await integration.coordinator.stop();marketing.closeAllConnections();integration.server.closeAllConnections();reviewer.closeAllConnections();
  await Promise.all([new Promise(r=>marketing.close(r)),new Promise(r=>integration.server.close(r)),new Promise(r=>reviewer.close(r))]);research.kill('SIGTERM');await once(research,'exit');await rm(dir,{recursive:true,force:true});
}
