import {chromium} from 'playwright';import AxeBuilder from '@axe-core/playwright';import {writeFile} from 'node:fs/promises';
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});const findings=[];
try{const context=await browser.newContext();const page=await context.newPage();for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});await page.goto(process.env.MARKETING_URL || 'http://127.0.0.1:3103');await page.locator('.question-button').first().waitFor();
  const home=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();findings.push({viewport:width,state:'homepage',violations:home.violations});
  await page.locator('[data-explore]').first().click();await page.locator('#credit-ack').waitFor();const bench=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();findings.push({viewport:width,state:'workbench research',violations:bench.violations});
  await page.locator('#credit-ack').check();await page.getByRole('button',{name:'Generate sample clips'}).click();await page.getByRole('button',{name:'Export sample evidence'}).waitFor();const review=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();findings.push({viewport:width,state:'workbench review',violations:review.violations});
  await page.evaluate(()=>sessionStorage.clear());
}
await writeFile(new URL('../deliverables/accessibility-verification.json',import.meta.url),JSON.stringify(findings,null,2)+'\n');for(const row of findings)console.log(row.viewport,row.state,row.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)})));
if(findings.some(r=>r.violations.length))process.exitCode=1;
}finally{await browser.close();}
