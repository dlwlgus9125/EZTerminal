// Checks the authored prototype, not the product, real providers or Android IME.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const root=path.dirname(fileURLToPath(import.meta.url));
const smoke=process.argv.includes('--smoke');
const screenDir=path.join(root,'screens');
await fs.mkdir(screenDir,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
const page=await context.newPage();
const errors=[];const requests=[];const checks=[];const captures=[];
page.on('pageerror',error=>errors.push(error.message));
await context.route(/^https?:/,route=>{requests.push(route.request().url());return route.abort();});
const link=options=>`${pathToFileURL(path.join(root,'index.html')).href}?${new URLSearchParams(options)}`;
async function go(scene='welcome',device='desktop',extra={}){
  await page.setViewportSize(device==='mobile'?{width:390,height:844}:{width:1440,height:900});
  await page.goto(link({scene,device,...extra}));
  await page.waitForFunction(()=>Boolean(window.chatReview));
  await page.evaluate(()=>document.fonts.ready);
}
const state=()=>page.evaluate(()=>window.chatReview.getState());
async function check(name,fn){
  try{await fn();checks.push({name,passed:true});console.log(`PASS ${name}`);}
  catch(error){checks.push({name,passed:false,error:String(error)});console.log(`FAIL ${name}: ${String(error).slice(0,450)}`);await page.screenshot({path:path.join(screenDir,`failure-${checks.length}.png`)}).catch(()=>{});}
}
async function overflow(){return page.evaluate(()=>({document:document.documentElement.scrollWidth>innerWidth+1,regions:[...document.querySelectorAll('.main,.manager,.transcript,.dialog,.composer-region,.review-toolbar')].filter(node=>node.getClientRects().length&&node.scrollWidth>node.clientWidth+2).map(node=>node.className)}));}
async function capture(name){const file=`${name}.png`;await page.screenshot({path:path.join(screenDir,file)});captures.push(file);}
try{
  await check('cold conversation is usable with zero simulated turns',async()=>{
    await go();assert.equal((await state()).modelTurns,0);assert.equal((await state()).session.messages.length,0);
    await expect(page.locator('.quick-skills [data-action="select-skill"]')).toHaveCount(3);
    await page.locator('[data-action="skills"]').first().click();
    await page.locator('#picker-search').fill('frontend');
    await page.locator('.picker-item[data-id="frontend"]').click();
    await expect(page.locator('.chip.skill')).toContainText('frontend-design');assert.equal((await state()).modelTurns,0);
  });
  await go();await capture('desktop-welcome');
  await go('welcome','mobile');await capture('mobile-welcome');
  if(!smoke){
    await check('selection, draft, attachment and caret survive skin and manager navigation',async()=>{
      await go('compose');await page.locator('#draft').fill('유지할 초안 with a skill');
      await page.locator('#draft').evaluate(node=>node.setSelectionRange(2,5));
      await page.locator('[data-action="skin"]').click();
      await expect(page.locator('#draft')).toHaveValue('유지할 초안 with a skill');
      assert.deepEqual((await state()).session.selection,[2,5]);
      await page.locator('.header-right [data-action="extensions"]').click();
      await page.locator('.manager-intro [data-action="chat"]').click();
      await expect(page.locator('#draft')).toHaveValue('유지할 초안 with a skill');
      assert.deepEqual((await state()).session.selected,['frontend']);assert.equal((await state()).session.attachments.length,1);assert.equal((await state()).modelTurns,0);
    });
    await check('first send carries selected skills and attachments',async()=>{
      await go('compose');await page.locator('#send').click();
      const s=await state();assert.equal(s.modelTurns,1);assert.deepEqual(s.session.messages[0].skills,['frontend']);assert.deepEqual(s.session.messages[0].attachments,['src/LoginPanel.tsx']);await expect(page.locator('#draft')).toHaveValue('');
    });
    await check('keyboard picker and Escape restore focus without sending',async()=>{
      await go();await page.locator('#draft').pressSequentially('/');await expect(page.locator('#picker-search')).toBeFocused();await page.keyboard.press('ArrowDown');await expect(page.locator('.picker-item').first()).toBeFocused();await page.keyboard.press('Escape');await expect(page.locator('#draft')).toBeFocused();assert.equal((await state()).modelTurns,0);
    });
    await check('IME Enter and Android Enter do not send',async()=>{
      await go();await page.locator('#draft').fill('한글 조합 중');await page.locator('#draft').dispatchEvent('keydown',{key:'Enter',isComposing:true,keyCode:229});assert.equal((await state()).modelTurns,0);
      await go('welcome','mobile');await page.locator('#draft').fill('모바일 입력');await page.locator('#draft').press('Enter');assert.equal((await state()).modelTurns,0);await expect(page.locator('#draft')).toHaveValue('모바일 입력\n');
    });
    await check('question answer and approval decisions are distinct',async()=>{
      await go('question');await expect(page.locator('[data-action="answer"]')).toBeDisabled();await page.locator('input[name="answer"][value="both"]').check();await page.locator('[data-action="answer"]').click();assert.equal((await state()).session.question,'answered');
      await go('approval');await page.locator('[data-action="deny"]').click();assert.equal((await state()).session.approval,'deny');assert.equal((await state()).modelTurns,0);
    });
    await check('queue editing, stop and explicit resume preserve the conversation',async()=>{
      await go('queue');await page.locator('[data-action="queue-edit"]').click();assert.equal((await state()).session.queue.length,0);await expect(page.locator('#draft')).toHaveValue('키보드 포커스 표시도 살펴봐줘.\n모바일에서 오류 안내도 같이 확인해줘.');assert.deepEqual((await state()).session.selected,['frontend']);await page.locator('[data-action="stop"]').click();assert.equal((await state()).session.status,'interrupted');await page.locator('[data-action="continue"]').click();assert.equal((await state()).modelTurns,1);
    });
    await check('queued messages retain skill and attachment context',async()=>{
      await go('queue');await page.locator('[data-action="skills"]').first().click();await page.locator('.picker-item[data-id="diagnose"]').click();await page.locator('[data-action="attachment"]').click();await page.locator('[data-action="add-sample-image"]').click();await page.locator('#send').click();const packet=(await state()).session.queue[1];assert.deepEqual(packet.skills,['diagnose']);assert.deepEqual(packet.attachments,['login-screen.png']);await page.locator('[data-action="queue-edit"][data-index="1"]').click();assert.deepEqual((await state()).session.selected,['diagnose']);assert.deepEqual((await state()).session.attachments,['login-screen.png']);
    });
    await check('conversation switching preserves independent drafts',async()=>{
      await go('compose');const original=(await state()).session.draft;await page.locator('.header-right [data-action="new-chat"]').click();await expect(page.locator('#draft')).toHaveValue('');await page.locator('#draft').fill('두 번째 초안');await page.locator('.sidebar [data-action="session"][data-id="draft-1"]').click();await expect(page.locator('#draft')).toHaveValue(original);await page.locator('.sidebar [data-action="session"][data-id="draft-2"]').click();await expect(page.locator('#draft')).toHaveValue('두 번째 초안');assert.equal((await state()).modelTurns,0);
    });
    await check('mid-draft command preserves surrounding text and changes options without a turn',async()=>{
      await go();await page.locator('#draft').fill('앞 내용  뒤 내용');await page.locator('#draft').evaluate(node=>{node.focus();node.setSelectionRange(5,5);});await page.keyboard.insertText('/');await page.locator('[data-command="true"][data-action="model"]').click();await page.locator('#model-choice').selectOption('GPT-6');await page.locator('[data-action="save-model"]').click();await expect(page.locator('#draft')).toHaveValue('앞 내용  뒤 내용');assert.equal((await state()).session.model,'GPT-6');assert.equal((await state()).modelTurns,0);
    });
    await check('disabled selected skill blocks sending until removed',async()=>{
      await go('compose');await page.locator('.header-right [data-action="extensions"]').click();await page.locator('[data-action="manager-tab"][data-id="plugins"]').click();await page.locator('[data-action="plugin-detail"]').click();await page.locator('[data-action="toggle-plugin"]').click();await page.locator('.sidebar [data-action="chat"]').click();await expect(page.locator('#send')).toBeDisabled();await page.locator('[data-action="remove-skill"]').click();await expect(page.locator('#send')).toBeEnabled();assert.equal((await state()).modelTurns,0);
    });
    await check('unsupported reasoning keeps basic conversation available',async()=>{
      await go('unsupported');await expect(page.locator('[aria-label="추론 수준"]')).toBeDisabled();await page.locator('[aria-label="모델과 추론 설정"]').click();await expect(page.locator('#effort-choice')).toBeDisabled();await page.locator('[data-action="save-model"]').click();await page.locator('#draft').fill('일반 대화');await page.locator('#send').click();assert.equal((await state()).modelTurns,1);
    });
    await check('MCP failed connection recovers and respects scope filtering',async()=>{
      await go('mcp-failed','mobile');await expect(page.locator('.extension-row').filter({hasText:'Project tools'})).toContainText('연결 실패');await page.locator('[data-action="reconnect-mcp"]').click();await expect(page.locator('.extension-row').filter({hasText:'Project tools'})).toContainText('연결됨');await page.locator('#scope-filter').selectOption('project');await expect(page.locator('.extension-row')).toHaveCount(1);assert.equal((await state()).modelTurns,0);
    });
    await check('source validation, explicit install, return to original draft',async()=>{
      await go('compose');const draft=(await state()).session.draft;
      await page.locator('.header-right [data-action="extensions"]').click();await page.locator('[data-action="install-source"]').click();await page.locator('#install-source').fill('bad');await page.locator('[data-action="review-install"]').click();await expect(page.locator('.field-error')).toBeVisible();assert.equal((await state()).simulatedInstalls,0);
      await page.locator('#install-source').fill('https://github.com/example/accessibility-toolkit');await page.locator('[data-action="review-install"]').click();assert.equal((await state()).simulatedInstalls,0);await page.locator('[data-action="confirm-install"]').click();await expect(page.locator('.dialog')).toHaveCount(0);assert.equal((await state()).simulatedInstalls,1);
      await page.locator('[data-action="skill-detail"][data-id="accessibility"]').click();await expect(page.locator('.dialog')).toContainText('이 프로젝트');await expect(page.locator('[data-action="plugin-detail"][data-id="accessibility"]')).toBeVisible();await page.locator('[data-action="use-managed-skill"]').click();await expect(page.locator('#draft')).toHaveValue(draft);assert.ok((await state()).session.selected.includes('accessibility'));assert.equal((await state()).modelTurns,0);
    });
    await check('remote management explicitly identifies the PC and preserves provider isolation',async()=>{
      await go('installed','mobile');await expect(page.locator('.scope-bar')).toContainText('WORKSTATION');await page.locator('#management-provider').selectOption('claude');await page.locator('[data-action="manager-tab"][data-id="plugins"]').click();await page.locator('[data-action="plugin-detail"]').click();await page.locator('[data-action="toggle-plugin"]').click();assert.equal((await state()).session.provider,'codex');await page.locator('.back-link').click();await expect(page.locator('.extension-row')).toContainText('사용 안 함');
    });
    await check('plugin removal requires confirmation and preserves history',async()=>{
      await go('plugin');await page.locator('[data-action="remove-plugin"]').click();await expect(page.locator('#dialog-cancel')).toBeFocused();await page.locator('#dialog-cancel').click();await expect(page.locator('[data-action="remove-plugin"]')).toBeVisible();await page.locator('[data-action="remove-plugin"]').click();await page.locator('[data-action="confirm-remove-plugin"]').click();assert.equal((await state()).session.messages.length,0);assert.equal((await state()).modelTurns,0);
    });
    await check('MCP validation and authentication are separate actions',async()=>{
      await go('mcp');await page.locator('[data-action="add-mcp"]').click();await page.locator('[data-action="save-mcp"]').click();await expect(page.locator('.field-error')).toBeVisible();await page.locator('#server-name').fill('New documents');await page.locator('#server-address').fill('https://example.com/mcp');await page.locator('[data-action="save-mcp"]').click();await expect(page.locator('.extension-row')).toHaveCount(4);assert.equal((await state()).modelTurns,0);
      await go('mcp-auth','mobile');await expect(page.locator('.dialog')).toContainText('WORKSTATION');await page.locator('[data-action="check-auth"]').click();await expect(page.locator('.extension-row').filter({hasText:'Design library'})).toContainText('연결됨');
    });
    await check('offline reconnect and uncertain delivery never resend',async()=>{
      await go('offline','mobile');const original=(await state()).session.draft;await expect(page.locator('#send')).toBeDisabled();await page.locator('[data-action="reconnect"]').click();await expect(page.locator('#draft')).toHaveValue(original);assert.equal((await state()).modelTurns,0);
      await go('uncertain');await expect(page.locator('#send')).toBeDisabled();await page.locator('[data-action="reconcile"]').click();assert.equal((await state()).modelTurns,0);assert.equal((await state()).session.uncertain,false);
    });
    await check('review notes persist without creating approval',async()=>{
      await go();await page.locator('[data-action="review"]').click();await page.locator('#review-text').fill('첫 화면 검토 의견 <script>example</script>');await page.locator('#review-status').selectOption('changes');await page.locator('[data-action="save-review"]').click();await page.reload();await page.locator('[data-action="review"]').click();await expect(page.locator('#review-text')).toHaveValue('첫 화면 검토 의견 <script>example</script>');assert.equal((await state()).approved,false);
    });
    await check('Claude skill invocation label and basic settings are available before a turn',async()=>{
      await go('installed','desktop',{provider:'claude'});await page.locator('[data-action="skill-detail"][data-id="frontend"]').click();await expect(page.locator('.dialog code')).toHaveText('/ezpowers:frontend-design');await page.locator('[data-action="use-managed-skill"]').click();await page.locator('[data-action="permission"]').click();await page.locator('input[value="plan"]').check();await page.locator('[data-action="save-permission"]').click();assert.equal((await state()).session.permission,'plan');assert.equal((await state()).modelTurns,0);
    });
    await check('pending action is visible when reopening a conversation',async()=>{
      for(const device of ['desktop','mobile']){await go('approval',device);const card=await page.locator('[data-action="allow"]').boundingBox();const transcript=await page.locator('.transcript').boundingBox();assert.ok(card&&transcript&&card.y>=transcript.y&&card.y+card.height<=transcript.y+transcript.height);}
    });
    await go();const scenes=await page.evaluate(()=>window.chatReview.scenes);
    for(const device of ['desktop','mobile'])for(const scene of scenes){
      await check(`screen ${device}/${scene}`,async()=>{await go(scene,device);const result=await overflow();assert.equal(result.document,false);assert.deepEqual(result.regions,[]);await capture(`${device}-${scene}`);});
    }
    for(const [scene,device,extra]of [['welcome','desktop',{}],['skills','desktop',{}],['question','mobile',{}],['installed','desktop',{}],['mcp','mobile',{}],['install','mobile',{}],['approval','desktop',{theme:'light'}],['welcome','mobile',{theme:'high-contrast',lang:'en'}],['compose','desktop',{theme:'matrix',skin:'cli'}]]){
      await check(`accessibility ${device}/${scene}/${extra.theme||'dark'}`,async()=>{await go(scene,device,extra);const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(audit.violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>node.target)})),[]);await capture(`${device}-${scene}-${extra.theme||'dark'}-${extra.lang||'ko'}`);});
    }
    for(const viewport of [{width:1024,height:720},{width:800,height:600},{width:360,height:800}]){
      await check(`responsive ${viewport.width}`,async()=>{await go('compose',viewport.width<700?'mobile':'desktop',{lang:'en',skin:'cli'});await page.setViewportSize(viewport);const result=await overflow();assert.equal(result.document,false);assert.deepEqual(result.regions,[]);const send=await page.locator('#send').boundingBox();assert.ok(send&&send.y>=0&&send.y+send.height<=viewport.height);await capture(`responsive-${viewport.width}-cli-en`);});
    }
  }
  await check('no runtime errors or external requests',()=>{assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);});
}finally{
  await browser.close();
  const report={kind:'design-reference-only',smoke,generatedAt:new Date().toISOString(),productValidation:false,physicalAndroidIME:false,performanceMeasurement:false,approved:false,passed:checks.every(check=>check.passed),checks,captures,errors,externalRequests:requests};
  await fs.writeFile(path.join(root,smoke?'smoke-report.json':'qa-report.json'),JSON.stringify(report,null,2)+'\n');
}
if(checks.some(check=>!check.passed))process.exitCode=1;
