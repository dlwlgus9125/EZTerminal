// Meaningful interaction checks for this in-memory review, never product/provider validation.
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
page.on('pageerror',error=>errors.push(error.message));
await context.route(/^https?:/,route=>{requests.push(route.request().url());return route.abort();});
const state=()=>page.evaluate(()=>window.chatReview.getState());
const click=action=>page.locator(`[data-action="${action}"]:visible`).first().click();
async function go(scene='plans-home',device='desktop',extra={}) {
  await page.setViewportSize(device==='mobile'?{width:390,height:844}:{width:1440,height:900});
  await page.goto(`${pathToFileURL(path.join(root,'index.html')).href}?${new URLSearchParams({scene,device,...extra})}`);
  await page.waitForFunction(()=>window.chatReview);
}
async function check(name,fn){try{await fn();checks.push({name,passed:true});console.log(`PASS ${name}`);}catch(error){checks.push({name,passed:false,error:String(error)});console.log(`FAIL ${name}: ${String(error).slice(0,500)}`);}}
async function create(title,purpose='새 기능의 정상 흐름과 완료 조건을 정리한다.') {
  await click('p-new');await page.locator('#p-title').fill(title);await page.locator('#p-purpose').fill(purpose);await click('p-create');
}
try {
  for(const device of ['desktop','mobile']){
    await check(`${device}: empty project, cancel, create and discuss without a model turn`,async()=>{
      await go('plans-empty',device);assert.equal((await state()).workflow.plans.length,0);
      await click('p-new');await page.locator('#p-title').fill('취소할 기획');await click('p-cancel');assert.equal((await state()).workflow.plans.length,0);
      await create('첫 기획');assert.equal((await state()).workflow.plans.length,1);await expect(page.locator('#flow-document')).toHaveValue('새 기능의 정상 흐름과 완료 조건을 정리한다.');
      await page.locator('.flow-heading [data-action="j-open-chat"]').click();await expect(page.locator('.flow-context')).toContainText('첫 기획');assert.equal((await state()).modelTurns,0);
      await expect(page.locator('[data-action="skills"]').first()).toBeVisible();
    });
    await check(`${device}: switching plans preserves separate document and conversation drafts`,async()=>{
      await go('plans-list',device);await page.locator('.plan-open[data-id="login"]').click();await page.locator('#flow-document').fill('A 문서 미저장 편집');
      await page.locator('.flow-heading [data-action="j-open-chat"]').click();await page.locator('#draft').fill('A 대화 미전송 입력');
      await click('p-list');await page.locator('.plan-open[data-id="payment"]').click();await expect(page.locator('#flow-document')).not.toHaveValue('A 문서 미저장 편집');await page.locator('#flow-document').fill('B 문서 미저장 편집');
      await page.locator('.flow-heading [data-action="j-open-chat"]').click();await page.locator('#draft').fill('B 대화 미전송 입력');
      await click('p-list');await page.locator('.plan-open[data-id="login"]').click();await expect(page.locator('#flow-document')).toHaveValue('A 문서 미저장 편집');
      await page.locator('.flow-heading [data-action="j-open-chat"]').click();await expect(page.locator('#draft')).toHaveValue('A 대화 미전송 입력');
      await click('p-list');await page.locator('.plan-open[data-id="payment"]').click();await expect(page.locator('#flow-document')).toHaveValue('B 문서 미저장 편집');assert.equal((await state()).modelTurns,0);
    });
    await check(`${device}: link a general conversation without recreating or sending it`,async()=>{
      await go('plans-from-chat',device);await page.locator('#draft').fill('이 입력도 유지해줘');const before=(await state()).session;
      await click('p-link');await page.locator('#p-title').fill('대화에서 시작한 기획');await click('p-create');const after=await state();
      assert.equal(after.session.id,before.id);assert.deepEqual(after.session.messages,before.messages);assert.equal(after.session.provider,before.provider);assert.equal(after.modelTurns,0);await expect(page.locator('#draft')).toHaveValue('이 입력도 유지해줘');await expect(page.locator('.flow-context')).toContainText('대화에서 시작한 기획');
      await page.locator('.flow-context [data-action="j-return"]').click();await expect(page.locator('#flow-document')).toContainText('결제 수단');
    });
    await check(`${device}: quick task prepares and starts without a plan or hidden turn`,async()=>{
      await go('plans-quick',device);const count=(await state()).workflow.plans.filter(p=>!p.quick).length;
      await click('p-quick-create');await expect(page.locator('#p-form-error')).toContainText('목적');
      await page.locator('#p-title').fill('버튼 이름 수정');await page.locator('#p-purpose').fill('버튼의 접근 가능한 이름을 수정한다.');await page.locator('#p-acceptance').fill('스크린리더로 버튼의 목적을 알 수 있다.');await click('p-quick-create');
      assert.equal((await state()).workflow.plans.filter(p=>!p.quick).length,count);await expect(page.locator('.flow-task-card')).toContainText('빠른 작업의 목적');
      await click('j-prepare');await click('j-confirm-prepare');assert.equal((await state()).modelTurns,0);await click('j-start');await click('j-confirm-start');assert.equal((await state()).modelTurns,1);await expect(page.locator('.plan-scope')).toContainText('버튼 이름 수정');
    });
  }
  await check('link an existing plan without overwriting its document',async()=>{
    await go('plans-from-chat');const before=(await state()).workflow.plans.find(p=>p.id==='payment').workflow.planSaved;
    await click('p-link');await page.locator('#p-target').selectOption('payment');await click('p-create');const after=await state();assert.equal(after.workflow.plans.length,2);assert.equal(after.workflow.planSaved,before);assert.equal(after.session.workflow.planId,'payment');
  });
  await check('archive, filter and restore preserve plan content',async()=>{
    await go('plans-list');const before=(await state()).workflow.plans.find(p=>p.id==='payment').workflow.planSaved;
    await page.locator('[data-action="p-archive"][data-id="payment"]').click();await expect(page.locator('.dialog')).toContainText('보관');await click('p-confirm-archive');await expect(page.locator('.plan-open[data-id="payment"]')).toHaveCount(0);
    await page.locator('#p-filter').selectOption('archived');await expect(page.locator('.plan-open[data-id="payment"]')).toBeVisible();await click('p-restore');await page.locator('.plan-open[data-id="payment"]').click();await expect(page.locator('#flow-document')).toHaveValue(before);
  });
  await check('search and unmatched search do not erase records',async()=>{
    await go('plans-list');await page.locator('#p-search').fill('결제');await expect(page.locator('.plan-row')).toHaveCount(1);await page.locator('#p-search').fill('없는 이름');await expect(page.locator('.plan-empty')).toBeVisible();await click('p-clear');await expect(page.locator('.plan-row')).toHaveCount(2);
  });
  await check('renaming and changing theme preserve unsaved document content',async()=>{
    await go('plans-list');await page.locator('.plan-open[data-id="payment"]').click();await page.locator('#flow-document').fill('테마를 바꿔도 남길 편집');await page.locator('#theme-select').selectOption('light');await expect(page.locator('#flow-document')).toHaveValue('테마를 바꿔도 남길 편집');
    await click('p-rename');await page.locator('#p-title').fill('결제 경험 개선');await click('p-save-name');await expect(page.locator('.plan-scope-name')).toContainText('결제 경험 개선');await expect(page.locator('#flow-document')).toHaveValue('테마를 바꿔도 남길 편집');
  });
  await check('review revisions preserve the old result and require a new explicit start',async()=>{
    await go('plans-rework');await click('p-rework');await page.locator('#p-reason').fill('오류 안내 문구를 보완해 주세요.');await click('p-confirm-rework');await expect(page.locator('#flow-document')).toBeVisible();const data=await state();assert.equal(data.workflow.taskStatus,'draft');assert.equal(data.modelTurns,0);assert.equal(data.workflow.plans.find(p=>p.id==='login').history.length,1);await click('p-history');await expect(page.locator('.dialog')).toContainText('오류 안내 문구');
  });
  await check('user titles render as text without HTML execution',async()=>{
    await go('plans-empty');await create('<img src=x onerror="window.injected=true">');assert.equal(await page.evaluate(()=>Boolean(window.injected)),false);await expect(page.locator('.plan-scope-name')).toContainText('<img');assert.equal(await page.locator('img[src="x"]').count(),0);
  });
  await fs.mkdir(path.join(root,'screens'),{recursive:true});
  for(const [scene,device,extra] of [['plans-home','desktop',{}],['plans-list','desktop',{}],['plans-new','desktop',{}],['plans-from-chat','desktop',{}],['plans-empty','mobile',{}],['plans-new','mobile',{}],['plans-linked','mobile',{}],['plans-quick','mobile',{}],['plans-archived','desktop',{lang:'en',theme:'light'}]]){
    await check(`${scene}/${device}: accessibility and capture`,async()=>{
      await go(scene,device,extra);const violations=(await new AxeBuilder({page}).analyze()).violations;assert.deepEqual(violations.map(v=>({id:v.id,nodes:v.nodes.length})),[]);const name=`plans-${scene}-${device}.png`;await page.screenshot({path:path.join(root,'screens',name),fullPage:true});captures.push(name);
    });
  }
  await check('no JavaScript errors or external requests',async()=>{assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);});
} finally {
  await browser.close();
  await fs.writeFile(path.join(root,'plans-report.json'),JSON.stringify({version:1,checkedAt:new Date().toISOString(),scope:'prototype only',passed:checks.every(c=>c.passed),checks,captures,errors,requests},null,2)+'\n');
}
if(checks.some(c=>!c.passed))process.exitCode=1;
