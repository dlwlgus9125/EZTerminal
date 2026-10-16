// Review-only behavior and accessibility; no product/provider/Android-device assertions.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const root=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
const page=await context.newPage(),checks=[],captures=[],errors=[],requests=[];
page.on('pageerror',e=>errors.push(e.message));
await context.route(/^https?:/,route=>{requests.push(route.request().url());return route.abort();});
const data=()=>page.evaluate(()=>window.chatReview.getState());
const click=action=>page.locator(action==='send'?'#send':`[data-action="${action}"]:visible`).first().click();
const nodeClick=(action,id)=>page.locator(`[data-action="${action}"][data-id="${id}"]:visible`).first().click();
const current=async()=>{const s=await data();return s.workflow.projects.find(p=>p.id===(s.session.flowScope?.subprojectId&&s.route==='chat'?s.session.flowScope.subprojectId:s.workflow.selected));};
async function go(scene='work-home',device='desktop',extra={}){
  await page.setViewportSize(device==='mobile'?{width:390,height:844}:{width:1440,height:1000});
  await page.goto(`${pathToFileURL(path.join(root,'index.html')).href}?${new URLSearchParams({scene,device,...extra})}`);
  await page.waitForFunction(()=>window.chatReview);
}
async function check(name,fn){try{await fn();checks.push({name,passed:true});console.log(`PASS ${name}`);}catch(e){checks.push({name,passed:false,error:String(e)});console.log(`FAIL ${name}: ${String(e).slice(0,700)}`);}}
async function create(title='검색 개선'){await click('wf-new');await page.locator('#wf-title').fill(title);await page.locator('#wf-purpose').fill('검색 결과를 빠르게 찾을 수 있다.');await click('wf-create');}
try{
  for(const device of ['desktop','mobile']){
    await check(`${device}: subprojects and general conversations are project siblings`,async()=>{
      await go('work-home',device);await expect(page.locator('.wf-sibling-list>[data-kind="sub"]')).toHaveCount(2);await expect(page.locator('.wf-sibling-list>[data-kind="chat"]')).toHaveCount(2);
      await click('new-chat');await page.locator('#draft').fill('계획 없이 질문만');assert.equal((await data()).workflow.projects.length,2);assert.equal((await data()).session.flowScope,undefined);assert.equal((await data()).modelTurns,0);
      const id=(await data()).session.id;await click('wf-home');await nodeClick('wf-session',id);await expect(page.locator('#draft')).toHaveValue('계획 없이 질문만');await expect(page.locator('.quick-skills')).toContainText('ezterminal-workflow');
    });
    await check(`${device}: cancel creates nothing; preset creation and stage opening submit zero turns`,async()=>{
      await go('work-empty',device);await click('wf-new');await page.locator('#wf-title').fill('취소');await click('wf-cancel');assert.equal((await data()).workflow.projects.length,0);
      await create();assert.equal((await data()).workflow.projects.length,1);await click('wf-view');await nodeClick('wf-view','list');await nodeClick('wf-node','plan');await click('wf-talk');assert.equal((await data()).modelTurns,0);await expect(page.locator('.flow-context')).toContainText('검색 개선');
    });
    await check(`${device}: conversational creation previews a parallel preset without creating early`,async()=>{
      await go('work-compose',device);await page.locator('#wf-title').fill('병렬 작업');await page.locator('#wf-purpose').fill('화면과 API를 함께 구현한다.');await click('wf-compose-example');await click('wf-compose');assert.equal((await data()).workflow.projects.length,2);assert.ok((await data()).workflow.formGraph.nodes.some(n=>n.type==='fork'));await click('wf-create');assert.ok((await current()).graph.nodes.some(n=>n.type==='join'));assert.equal((await data()).modelTurns,0);
    });
    await check(`${device}: same-stage multiple chats, other subproject and general draft stay independent`,async()=>{
      await go('work-stage',device);await page.locator('#wf-document').fill('A의 미저장 문서');await click('wf-talk');await page.locator('#draft').fill('A의 첫 대화');const first=(await data()).session.id;
      await click('wf-return-node');await click('wf-new-stage-chat');await page.locator('#draft').fill('A의 두 번째 대화');const second=(await data()).session.id;assert.notEqual(first,second);
      await click('wf-home');const other=(await data()).workflow.projects[1].id;await nodeClick('wf-open',other);await nodeClick('wf-view','list');await nodeClick('wf-node','plan');await page.locator('#wf-document').fill('B의 문서');await click('wf-talk');await page.locator('#draft').fill('B의 대화');
      await click('wf-home');await nodeClick('wf-open',(await data()).workflow.projects[0].id);await nodeClick('wf-view','list');await nodeClick('wf-node','plan');await expect(page.locator('#wf-document')).toHaveValue('A의 미저장 문서');await nodeClick('wf-session',first);await expect(page.locator('#draft')).toHaveValue('A의 첫 대화');
    });
    await check(`${device}: link an existing general session without copying, sending or overwriting`,async()=>{
      await go('work-general',device);await page.locator('#draft').fill('연결해도 남길 입력');const before=(await data()).session;const doc=(await data()).workflow.projects[0].graph.nodes[0].brief;
      await click('wf-link');await click('wf-confirm-link');const after=await data();assert.equal(after.session.id,before.id);assert.deepEqual(after.session.messages,before.messages);assert.equal(after.session.provider,before.provider);assert.equal(after.modelTurns,0);assert.equal(after.workflow.projects[0].graph.nodes[0].brief,doc);await expect(page.locator('#draft')).toHaveValue('연결해도 남길 입력');
      await click('wf-home');await expect(page.locator(`.wf-sibling-list [data-action="wf-session"][data-id="${before.id}"]`)).toHaveCount(0);
    });
    await check(`${device}: AI directly edits draft with undo and retains the frozen running graph`,async()=>{
      await go('work-running',device);const before=(await current()).runs[0].graph;await click('wf-graph-chat');await page.locator('#draft').fill('디자인 단계는 빼고 보안 검토를 추가해줘');await click('send');let p=await current();assert.ok(!p.graph.nodes.some(n=>n.id==='design'));assert.ok(p.graph.nodes.some(n=>n.id==='security'));assert.deepEqual(p.runs[0].graph,before);assert.equal((await data()).modelTurns,1);
      await click('wf-flow');await click('wf-draft');await click('wf-undo');p=await current();assert.ok(p.graph.nodes.some(n=>n.id==='design'));assert.deepEqual(p.runs[0].graph,before);
    });
    await check(`${device}: approval waits, pause prevents advancement, and completion follows explicit approval`,async()=>{
      await go('work-approval',device);assert.equal((await current()).runs[0].status,'waiting');await click('wf-pause');await expect(page.locator('[data-action="wf-approve"]')).toBeDisabled();await click('wf-pause');await click('wf-approve');await click('wf-tick');assert.equal((await current()).runs[0].status,'completed');assert.equal((await current()).runs[0].approvals.length,1);assert.equal((await data()).modelTurns,0);
    });
  }
  await check('renaming a node retains its chat identity and unsent input',async()=>{
    await go('work-chat');await page.locator('#draft').fill('이름 변경 후에도 유지');const id=(await data()).session.id;await page.locator('.wf-breadcrumb [data-action=wf-open]').click();await nodeClick('wf-select','plan');await page.locator('#wf-node-title').fill('요구사항 정리');await click('wf-save-node');await nodeClick('wf-node','plan');await click('wf-talk');assert.equal((await data()).session.id,id);await expect(page.locator('#draft')).toHaveValue('이름 변경 후에도 유지');await expect(page.locator('.flow-context')).toContainText('요구사항 정리');
  });
  await check('deleting a node keeps its conversations accessible and undo restores the node',async()=>{
    await go('work-chat');const id=(await data()).session.id;await page.locator('#draft').fill('삭제 전 입력');await page.locator('.wf-breadcrumb [data-action=wf-open]').click();await nodeClick('wf-select','plan');await click('wf-delete');await click('wf-confirm-delete');await expect(page.locator('[data-action="wf-start"]')).toBeDisabled();await click('wf-history');await click('wf-removed-chats');await nodeClick('wf-session',id);await expect(page.locator('#draft')).toHaveValue('삭제 전 입력');await expect(page.locator('.flow-context')).toContainText('보관된 단계');await page.locator('.wf-breadcrumb [data-action=wf-open]').click();await click('wf-undo');assert.ok((await current()).graph.nodes.some(n=>n.id==='plan'));
  });
  await check('connection deletion blocks execution; adding it back repairs the graph',async()=>{
    await go('work-graph');await page.locator('.wf-connections summary').click();await nodeClick('wf-remove-edge','0');await expect(page.locator('[data-action="wf-start"]')).toBeDisabled();await page.locator('.wf-connections summary').click();await page.locator('#wf-edge-from').selectOption('plan');await page.locator('#wf-edge-to').selectOption('design');await click('wf-add-edge');await expect(page.locator('[data-action="wf-start"]')).toBeEnabled();
  });
  await check('start confirmation freezes the graph and does not start a provider turn',async()=>{
    await go('work-graph');await click('wf-start');assert.equal((await current()).runs.length,0);await click('wf-confirm-start');assert.equal((await current()).runs.length,1);assert.equal((await data()).modelTurns,0);await expect(page.locator('.wf-run-controls')).toContainText('실제 AI');
  });
  await check('parallel branches activate together and join waits for both',async()=>{
    await go('work-parallel');await click('wf-start');await click('wf-confirm-start');await click('wf-tick');await click('wf-tick');assert.deepEqual((await current()).runs[0].active,['ui','api']);await click('wf-tick');const r=(await current()).runs[0];assert.deepEqual(r.active,['join']);assert.ok(r.events.some(e=>e.nodeId==='ui')&&r.events.some(e=>e.nodeId==='api'));
  });
  await check('failure follows the retry edge and stops at the retry limit',async()=>{
    await go('work-graph');await click('wf-start');await click('wf-confirm-start');await page.locator('#wf-outcome').selectOption('fail');
    for(let i=0;i<15&&(await current()).runs[0].status==='running';i++)await click('wf-tick');const r=(await current()).runs[0];assert.equal(r.retries,2);assert.equal(r.status,'blocked');assert.equal(r.events.filter(e=>e.nodeId==='build').length,3);
  });
  await check('new subproject from a general chat and cancel preserve the same session',async()=>{
    await go('work-general');await page.locator('#draft').fill('보존');const id=(await data()).session.id;await click('wf-link');await click('wf-link-new');await click('wf-cancel');assert.equal((await data()).session.id,id);await click('wf-link');await click('wf-link-new');await page.locator('#wf-title').fill('대화에서 생성');await page.locator('#wf-purpose').fill('대화의 목적');await click('wf-create');assert.equal((await data()).session.id,id);assert.equal((await data()).workflow.projects.length,3);await expect(page.locator('#draft')).toHaveValue('보존');
  });
  await check('archiving preserves data, restoration and search work, active runs cannot be archived',async()=>{
    await go('work-graph');const id=(await current()).id;await click('wf-archive');await page.locator('#wf-filter').selectOption('archived');await nodeClick('wf-open',id);await click('wf-restore');assert.equal((await current()).archived,false);await click('wf-home');await page.locator('#wf-search').fill('없는 항목');await expect(page.locator('.wf-page .wf-empty')).toBeVisible();
    await go('work-running');await click('wf-archive');assert.equal((await current()).archived,false);
  });
  await check('user-authored names and instructions render as text',async()=>{
    await go('work-empty');await create('<img src=x onerror="window.injected=1">');assert.equal(await page.evaluate(()=>window.injected),undefined);assert.equal(await page.locator('img[src=x]').count(),0);await expect(page.locator('.wf-heading')).toContainText('<img');
  });
  await check('first-turn app skill does not select a subproject implicitly',async()=>{
    await go('work-general');await page.locator('[data-action="select-skill"][data-id="ezterminal-workflow"]').click();await page.locator('#draft').fill('흐름을 수정해줘');const before=(await data()).workflow.projects;await click('send');assert.deepEqual((await data()).workflow.projects,before);await expect(page.locator('.transcript')).toContainText('먼저 선택');
  });
  await check('run conversation retains frozen settings even through command search',async()=>{
    await go('work-running');await nodeClick('wf-run-node','plan');const before=(await data()).session;await expect(page.locator('[data-action="model"]').first()).toBeDisabled();await click('skills');await page.locator('#picker-search').fill('model');await page.locator('.picker-item[data-action="model"]').click();await expect(page.locator('.dialog')).toContainText('확정한 설정');const after=(await data()).session;assert.equal(after.model,before.model);assert.equal(after.flowScope.runId,before.flowScope.runId);
  });
  await check('denying an approval preserves the run and prevents continuation',async()=>{
    await go('work-approval');const before=(await current()).runs[0].graph;await click('wf-deny');const run=(await current()).runs[0];assert.equal(run.status,'blocked');assert.equal(run.blockReason,'approval-denied');assert.deepEqual(run.graph,before);await expect(page.locator('[data-action="wf-tick"]')).toBeDisabled();await expect(page.locator('.wf-run-controls')).toContainText('승인을 거절');
  });
  await check('archived conversations remain readable and Enter cannot submit a preserved draft',async()=>{
    await go('work-chat');await page.locator('#draft').fill('보관해도 남는 초안');const s=(await data()).session,p=(await current()).id;
    await page.locator('.wf-breadcrumb [data-action=wf-open]').click();await click('wf-archive');await page.locator('#wf-filter').selectOption('archived');await nodeClick('wf-open',p);await nodeClick('wf-view','list');await nodeClick('wf-node','plan');await nodeClick('wf-session',s.id);await expect(page.locator('#draft')).toHaveAttribute('readonly','');await page.locator('#draft').press('Enter');assert.equal((await data()).modelTurns,0);await expect(page.locator('#draft')).toHaveValue('보관해도 남는 초안');
  });
  await fs.mkdir(path.join(root,'screens'),{recursive:true});
  for(const device of ['desktop','mobile'])for(const scene of ['home','new','compose','graph','parallel','stage','chat','general','assistant','running','approval','invalid']){
    await check(`${device}/${scene}: accessibility, overflow and capture`,async()=>{
      await go(`work-${scene}`,device);const violations=(await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations;assert.deepEqual(violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      if(['chat','general','assistant'].includes(scene)){const send=await page.locator('#send').boundingBox();assert.ok(send&&send.y+send.height<=(device==='mobile'?844:1000));}
      const name=`r4-${device}-${scene}.png`;await page.screenshot({path:path.join(root,'screens',name)});captures.push(name);
    });
  }
  for(const theme of ['light','high-contrast','matrix'])await check(`${theme}: English, CLI, and small-width workflow`,async()=>{
    await go('work-chat','mobile',{theme,lang:'en',skin:'cli'});await page.setViewportSize({width:360,height:800});const violations=(await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations;assert.deepEqual(violations.map(v=>v.id),[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);const file=`r4-${theme}-mobile-en-cli.png`;await page.screenshot({path:path.join(root,'screens',file)});captures.push(file);
  });
  await check('keyboard reaches primary actions and dialog Escape preserves the draft',async()=>{
    await go('work-general');await page.locator('#draft').fill('키보드 초안');await click('wf-link');await page.keyboard.press('Escape');await expect(page.locator('#draft')).toHaveValue('키보드 초안');await expect(page.locator('[data-action="wf-link"]')).toBeFocused();
  });
  await check('no JavaScript errors or external requests',async()=>{assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);});
}finally{
  await browser.close();await fs.writeFile(path.join(root,'workflows-report.json'),JSON.stringify({version:1,checkedAt:new Date().toISOString(),scope:'prototype only',passed:checks.every(c=>c.passed),checks,captures,errors,requests},null,2)+'\n');
}
if(checks.some(c=>!c.passed))process.exitCode=1;
