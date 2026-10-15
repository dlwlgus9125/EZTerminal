// User-facing journey checks for the review prototype; no product/provider validation.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const root=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
const page=await context.newPage();
const checks=[],errors=[],requests=[],captures=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route(/^https?:/,route=>{requests.push(route.request().url());return route.abort();});
const state=()=>page.evaluate(()=>window.chatReview.getState());
async function go(scene='flow-overview',device='desktop',extra={}){
  await page.setViewportSize(device==='mobile'?{width:390,height:844}:{width:1440,height:900});
  await page.goto(`${pathToFileURL(path.join(root,'index.html')).href}?${new URLSearchParams({scene,device,...extra})}`);
  await page.waitForFunction(()=>window.chatReview);
}
async function check(name,fn){try{await fn();checks.push({name,passed:true});console.log(`PASS ${name}`);}catch(error){checks.push({name,passed:false,error:String(error)});console.log(`FAIL ${name}: ${String(error).slice(0,650)}`);}}
const click=action=>page.locator(`[data-action="${action}"]`).first().click();
async function proposeAndApply(){await page.locator('#send').click();await expect(page.locator('[data-action="j-propose"]')).toBeVisible();await click('j-propose');await expect(page.locator('.flow-compare')).toBeVisible();await click('j-apply-proposal');}
try{
  await check('source to chat is zero-turn and preserves unsaved document and chat draft',async()=>{
    await go('flow-planning');await page.locator('#flow-document').fill('미저장 문서 편집');await page.locator('.flow-heading [data-action="j-open-chat"]').click();
    assert.equal((await state()).modelTurns,0);assert.equal((await state()).workflow.drafts.planning,'미저장 문서 편집');await expect(page.locator('.flow-context')).toContainText('v3');await expect(page.locator('.flow-context')).toContainText('저장 전 편집');
    await page.locator('#draft').fill('이어 쓸 대화 초안');await click('j-source');await expect(page.locator('.flow-source-text')).not.toContainText('미저장');await page.locator('.dialog [data-action="close"]').first().click();await page.locator('.flow-context [data-action="j-return"]').click();
    await expect(page.locator('#flow-document')).toHaveValue('미저장 문서 편집');await page.locator('.flow-linked-chat [data-action="j-open-chat"]').click();await expect(page.locator('#draft')).toHaveValue('이어 쓸 대화 초안');assert.equal((await state()).modelTurns,0);
  });
  await check('proposal comparison is explicit and does not execute a task',async()=>{
    await go('flow-plan-chat');await page.locator('#send').click();await expect(page.locator('[data-action="j-propose"]')).toBeVisible();const before=(await state()).workflow.planSaved;await click('j-propose');assert.equal((await state()).workflow.planSaved,before);await page.locator('#dialog-cancel').click();assert.equal((await state()).workflow.planRevision,3);await click('j-propose');await click('j-apply-proposal');assert.equal((await state()).workflow.planRevision,4);assert.equal((await state()).workflow.taskStatus,'draft');await expect(page.locator('#flow-document')).toContainText('스크린리더');
  });
  await check('stale proposals cannot overwrite a newer source',async()=>{
    await go('flow-stale');await expect(page.locator('.dialog')).toContainText('원본 버전이 바뀌었습니다');await expect(page.locator('[data-action="j-apply-proposal"]')).toHaveCount(0);const before=(await state()).workflow.planSaved;await page.locator('.dialog [data-action="j-return"]').click();assert.equal((await state()).workflow.planSaved,before);assert.equal((await state()).workflow.planRevision,4);
  });
  await check('unsaved source blocks apply and execution preparation',async()=>{
    await go('flow-planning');await page.locator('#flow-document').fill('보존할 원본 편집');await page.locator('.flow-heading [data-action="j-open-chat"]').click();await page.locator('#send').click();await expect(page.locator('[data-action="j-propose"]')).toBeVisible();await click('j-propose');await expect(page.locator('.dialog')).toContainText('저장하지 않은 편집');await expect(page.locator('[data-action="j-apply-proposal"]')).toHaveCount(0);await page.locator('.dialog [data-action="j-return"]').click();await page.locator('.flow-tabs [data-id="tasks"]').click();await click('j-prepare');assert.equal((await state()).workflow.taskStatus,'draft');await expect(page.locator('.dialog')).toHaveCount(0);assert.equal((await state()).workflow.drafts.planning,'보존할 원본 편집');
  });
  await check('a general conversation remains independent of stage references',async()=>{
    await go('flow-plan-chat');await page.locator('#draft').fill('기획에서 작성 중');await page.locator('.header-right [data-action="new-chat"]').click();assert.equal((await state()).session.workflow,undefined);await expect(page.locator('#draft')).toHaveValue('');await expect(page.locator('.flow-context')).toHaveCount(0);assert.equal((await state()).sessions['flow-planning-1'].draft,'기획에서 작성 중');assert.equal((await state()).modelTurns,0);
  });
  await check('frozen task settings also block command-menu changes',async()=>{
    await go('flow-task-chat');const before=(await state()).session.model;await expect(page.locator('.composer-options [data-action="model"]').first()).toBeDisabled();await page.locator('#draft').fill('');await page.locator('#draft').pressSequentially('/');await page.locator('[data-command="true"][data-action="model"]').click();await expect(page.locator('.dialog')).toContainText('실행에 확정된 AI 설정');assert.equal((await state()).session.model,before);assert.equal((await state()).modelTurns,0);
  });
  for(const device of ['desktop','mobile'])await check(`complete connected journey ${device}`,async()=>{
    await go('flow-planning',device);await page.locator('.flow-heading [data-action="j-open-chat"]').click();const planId=(await state()).session.id;await proposeAndApply();
    await page.locator('.flow-bottom-actions [data-id="design"]').click();await page.locator('.flow-heading [data-action="j-open-chat"]').click();const designId=(await state()).session.id;assert.notEqual(designId,planId);assert.equal((await state()).session.workflow.relatedReferences[0].revision,4);assert.ok((await state()).session.workflow.relatedReferences[0].text.includes('스크린리더'));await proposeAndApply();
    await page.locator('.flow-bottom-actions [data-id="tasks"]').click();const beforeStart=(await state()).modelTurns;await click('j-prepare');await click('j-confirm-prepare');assert.equal((await state()).workflow.taskStatus,'prepared');assert.equal((await state()).modelTurns,beforeStart);
    await click('j-start');await page.locator('#dialog-cancel').click();assert.equal((await state()).workflow.taskStatus,'prepared');await click('j-start');await click('j-confirm-start');const taskId=(await state()).session.id;assert.equal((await state()).modelTurns,beforeStart+1);assert.deepEqual((await state()).session.workflow.relatedReferences.map(ref=>ref.revision),[4,3]);
    await page.locator('.flow-context [data-action="j-return"]').click();await click('j-open-chat');assert.equal((await state()).session.id,taskId);assert.equal((await state()).modelTurns,beforeStart+1);await click('allow');await expect.poll(async()=>(await state()).workflow.taskStatus).toBe('completed');
    await page.locator('.flow-result-card [data-id="review"]').click();await expect(page.locator('[data-action="j-integrate"]')).toBeDisabled();await click('j-start-review');assert.notEqual((await state()).session.id,taskId);assert.equal((await state()).session.workflow.stage,'review');assert.equal((await state()).workflow.integrated,false);
    await page.locator('.flow-context [data-action="j-return"]').click();await click('j-integrate');assert.equal((await state()).workflow.integrated,false);await click('j-confirm-integrate');assert.equal((await state()).workflow.integrated,true);assert.equal((await state()).approved,false);
  });
  for(const [scene,device,extra] of [['flow-planning','desktop',{}],['flow-plan-chat','desktop',{}],['flow-proposal','desktop',{theme:'light'}],['flow-design','mobile',{}],['flow-task-chat','mobile',{}],['flow-review','mobile',{lang:'en'}]])await check(`journey accessibility ${scene}/${device}`,async()=>{
    await go(scene,device,extra);const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(audit.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})),[]);const file=`journey-${scene}-${device}-${extra.theme||'dark'}.png`;await fs.mkdir(path.join(root,'screens'),{recursive:true});await page.screenshot({path:path.join(root,'screens',file)});captures.push(file);
  });
  await check('journey performs no external requests and reports no runtime errors',()=>{assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);});
}finally{await browser.close();await fs.writeFile(path.join(root,'journey-report.json'),JSON.stringify({generatedAt:new Date().toISOString(),kind:'design-reference-only',productValidation:false,approved:false,passed:checks.every(c=>c.passed),checks,errors,externalRequests:requests,captures},null,2)+'\n');}
if(checks.some(c=>!c.passed))process.exitCode=1;
