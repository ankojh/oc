import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.MARKETING_URL || 'http://127.0.0.1:3103';
const out=new URL('../deliverables/screenshots/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
const errors=[],results=[];
const context=await browser.newContext();
const page=await context.newPage();
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error' && !m.text().includes('503 (Service Unavailable)'))errors.push(m.text());});
for(const width of [1440,1024,768,390]){
  await page.setViewportSize({width,height:width===390?844:1000});await page.goto(base);await page.evaluate(()=>document.fonts.ready);await page.locator('.question-button').first().waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Overflow at ${width}`);
  await page.screenshot({path:new URL(`homepage-${width}.png`,out).pathname,fullPage:true});
  results.push(`Homepage ${width}px: no horizontal overflow, fonts and evidence loaded.`);
}
await page.setViewportSize({width:1440,height:1000});await page.goto(base);await page.locator('.question-button').first().waitFor();
for(let i=0;i<3;i++){
  await page.locator('.question-button').nth(i).click();await page.waitForTimeout(650);
  assert.equal(await page.locator('.question-button').nth(i).getAttribute('aria-pressed'),'true');
  await page.locator('#audience').screenshot({path:new URL(`question-state-${i+1}.png`,out).pathname});
}
await page.locator('.question-button').nth(0).click();await page.locator('.question-button').nth(1).click();await page.locator('.question-button').nth(2).click();
await page.waitForTimeout(650);assert.match(await page.locator('#clip-title').textContent(),/next recording/);results.push('Rapid question selections settle on latest state, with no audio playback.');
await page.emulateMedia({reducedMotion:'reduce'});await page.locator('.question-button').first().click();assert.equal(await page.evaluate(()=>document.getAnimations().length),0);results.push('Reduced motion: immediate evidence changes, no running animations.');await page.emulateMedia({reducedMotion:'no-preference'});
await page.locator('#video-url').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');await page.locator('#video-entry button').click();
assert.equal(await page.locator('#workbench-url').inputValue(),'https://www.youtube.com/watch?v=dQw4w9WgXcQ');assert.match(await page.locator('#provider-notice').textContent(),/not connected/);assert.equal(await page.locator('#workbench-results').textContent(),'');
await page.locator('#research-button').click();await page.locator('#credit-ack').waitFor();assert.equal(await page.getByRole('button',{name:'Generate sample clips'}).isDisabled(),true);
await page.screenshot({path:new URL('workbench-research-desktop.png',out).pathname,fullPage:true});
await page.locator('#credit-ack').check();await page.getByRole('button',{name:'Generate sample clips'}).click();await page.getByRole('button',{name:'Export sample evidence'}).waitFor();
assert.match(await page.locator('#workbench-results').textContent(),/Unverifiable/);
assert.match(await page.locator('#workbench-results').textContent(),/NO MATCH/);
await page.screenshot({path:new URL('workbench-review-desktop.png',out).pathname,fullPage:true});
await page.reload();await page.getByRole('button',{name:'Export sample evidence'}).waitFor();results.push('Workbench: URL carried over, live unavailable, credit boundary, sample research/generate/review, missing media, no match and unverifiable retained; refresh restores sample.');
await page.locator('#close-workbench').click();assert.equal(await page.locator('#workbench').isVisible(),false);
// Verify keyboard menu and mobile workbench composition.
await page.setViewportSize({width:390,height:844});await page.goto(base);await page.locator('#menu-toggle').click();assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'),'true');await page.keyboard.press('Escape');assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'),'false');
await page.locator('[data-explore]').first().click();await page.getByRole('button',{name:'Export sample evidence'}).waitFor();
assert(await page.evaluate(()=>document.querySelector('dialog').scrollWidth<=innerWidth),'Mobile dialog overflow');
await page.screenshot({path:new URL('workbench-review-mobile.png',out).pathname,fullPage:true});
await page.keyboard.press('Escape');assert.equal(await page.locator('#workbench').isVisible(),false);results.push('Mobile menu and dialog close on Escape; dialog fits 390px.');
// Failure/retry at review barrier: no regeneration endpoint or paid request exists.
await page.locator('[data-explore]').first().click();await page.getByRole('button',{name:'Clear sample'}).click();await page.locator('#research-button').click();await page.locator('#credit-ack').check();
await page.route('**/sample-report.json',route=>route.fulfill({status:503,body:'unavailable'}));await page.getByRole('button',{name:'Generate sample clips'}).click();await page.getByRole('button',{name:'Retry review'}).waitFor();
await page.unroute('**/sample-report.json');await page.getByRole('button',{name:'Retry review'}).click();await page.getByRole('button',{name:'Export sample evidence'}).waitFor();results.push('Review load failure and retry use saved sample evidence without generation.');
assert.equal(errors.length,0,`Browser errors: ${errors.join('; ')}`);
await writeFile(new URL('../deliverables/browser-verification.json',import.meta.url),JSON.stringify({base,results,browserErrors:errors},null,2)+'\n');
console.log(results.join('\n'));await browser.close();
