// Design-reference verification only. Does not start Electron, providers or terminals.
import {verifyPolicies} from './verify-policies.mjs';
import {verifyTerminalSkin} from './verify-terminal-skin.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { screens,features,journeys,roadmap,handoffs,meta,aiProfiles,deliveryStages } from './content.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const pageUrl=new URL('./index.html',import.meta.url).href;
const report={packageVersion:meta.version,createdAt:new Date().toISOString(),scope:'Standalone planning reference only; no product e2e or performance benchmark',screens:[],states:[],responsive:[],interactions:[],accessibility:[],issues:[],userReview:'whole-design-authorized; individual clicks not asserted',implementationApproved:meta.implementationApproved===true};
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const ids=new Set(screens.map(s=>s.id));
const phaseIds=new Set(roadmap.map(r=>r.id));
assert(ids.size===59&&!ids.has('D14'),'59 unique screens without D14');
assert(screens.filter(s=>s.platform==='windows').length===43,'43 Windows screens');
assert(screens.filter(s=>s.platform==='android').length===16,'16 Android screens');
for(const f of features)assert(screens.some(s=>s.featureIds.includes(f.id)),`${f.id} has no screen`);
for(const j of journeys)for(const id of j.steps)assert(ids.has(id),`${j.id} invalid screen`);
for(const r of roadmap)for(const id of r.depends)assert(phaseIds.has(id),`${r.id} invalid dependency`);
const done=new Set();
while(done.size<roadmap.length){const next=roadmap.filter(r=>!done.has(r.id)&&r.depends.every(id=>done.has(id)));assert(next.length,'Roadmap contains a cycle');next.forEach(r=>done.add(r.id));}
for(const s of screens)assert(handoffs.some(w=>w.screens.includes(s.id)),`${s.id} has no implementation owner`);
await fs.mkdir(path.join(root,'screens/detail'),{recursive:true});
await fs.mkdir(path.join(root,'screens/wireframe'),{recursive:true});
await fs.mkdir(path.join(root,'screens/variants'),{recursive:true});
await fs.mkdir(path.join(root,'screens/flows'),{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,reducedMotion:'reduce'});
const page=await context.newPage();
const consoleErrors=[];
page.on('pageerror',error=>consoleErrors.push(error.message));
const externalRequests=[];
await context.route(/^https?:/,route=>{externalRequests.push(route.request().url());return route.abort();});
const go=async(id,extra={},viewport=null)=>{
 const mobile=id.startsWith('M');
 await page.setViewportSize(viewport||{width:mobile?390:1440,height:mobile?844:900});
 const params=new URLSearchParams({theme:'dark',skin:'bubble',view:'detail',state:'ready',interactive:'0',...(id==='D18'?{session:'experience',artifact:'0'}:{}),...extra});
 await page.goto(`${pageUrl}#render/${id}?${params}`,{waitUntil:'load'});
 await page.locator(`[data-screen-id="${id}"][data-review-state="${params.get('state')}"]`).waitFor();
 await page.waitForFunction(view=>document.body.dataset.view===view,params.get('view'));
 await page.evaluate(()=>document.fonts.ready);
};
const overflow=()=>page.evaluate(()=>({document:document.documentElement.scrollWidth>innerWidth+1,regions:[...document.querySelectorAll('.product-body,.mobile-body,.document-pane,.chat-scroll')].filter(el=>el.scrollWidth>el.clientWidth+2).map(el=>({class:el.className,width:el.clientWidth,scroll:el.scrollWidth}))}));
const portalGo=async route=>{
 await page.goto(`${pageUrl}#${route}`);
 if(route.startsWith('screen/'))await page.locator('#screen-frame').waitFor();
 else await page.locator(`.review-nav a.active[href="#${route.split('?')[0]}"]`).waitFor();
 if(route.startsWith('flows')){
  const params=new URLSearchParams(route.split('?')[1]||'');
  const id=journeys.some(j=>j.id===params.get('journey'))?params.get('journey'):'U01';
  await page.locator(`[data-journey="${id}"]`).waitFor();
  await page.locator(`#flow-view-${params.get('view')==='wireframe'?'wireframe':'detail'}[aria-pressed="true"]`).waitFor();
 }
 if(route.startsWith('ai')){
  const requested=new URLSearchParams(route.split('?')[1]||'').get('profile');
  const profile=aiProfiles.find(p=>p.id===requested)||aiProfiles[0];
  await page.locator(`[data-profile="${profile.id}"]`).waitFor();
 }
 await page.evaluate(async()=>{for(const img of document.images){img.loading='eager';await img.decode();}await document.fonts.ready;});
};

try {
 for(const [index,s] of screens.entries()){
  await go(s.id);
  const heading=await page.locator('h1').first().innerText();
  assert(heading===(s.id==='D18'?'대화 경험 정리':s.name),`${s.id} title mismatch`);
  const layout=await overflow();
  if(layout.document||layout.regions.length)report.issues.push({screen:s.id,kind:'overflow',...layout});
  await page.screenshot({path:path.join(root,'screens/detail',`${s.id}.png`)});
  await go(s.id,{view:'wireframe'});
  await page.screenshot({path:path.join(root,'screens/wireframe',`${s.id}.png`)});
  report.screens.push({id:s.id,detail:`screens/detail/${s.id}.png`,wireframe:`screens/wireframe/${s.id}.png`,heading:true,overflow:layout});
  for(const [state,text] of Object.entries(s.states))if(state!=='ready'){
   await go(s.id,{state});
   assert((await page.locator('.state-card,.policy-state').innerText()).includes(text),`${s.id}/${state} content mismatch`);
   report.states.push({screen:s.id,state,passed:true});
  }
  if((index+1)%10===0)console.log(`Rendered ${index+1}/${screens.length} screens and their states.`);
 }
 for(const [id,size] of [['D15',[800,600]],['D17',[800,600]],['D19',[800,600]],['D24',[800,600]],['D36',[800,600]],['M08',[360,640]],['M15',[360,640]],['D05',[800,600]],['D10',[800,600]],['D11',[800,600]],['D16',[1024,720]],['D20',[1200,800]],['D18',[1920,1080]],['D18',[800,600]],['D18',[1024,720]],['D18',[1200,800]],['D20',[800,600]],['D21',[800,600]],['M04',[360,640]],['M06',[360,640]],['M07',[412,915]],['M15',[800,1280]]]){
  await go(id,{}, {width:size[0],height:size[1]});const layout=await overflow();
  report.responsive.push({screen:id,size,overflow:layout});
  if(layout.document||layout.regions.length)report.issues.push({screen:id,kind:'responsive-overflow',size,...layout});
  await page.screenshot({path:path.join(root,'screens/variants',`${id}-${size.join('x')}.png`)});
 }
 for(const [id,extra,name] of [['D05',{theme:'light'},'light'],['D18',{skin:'terminal'},'terminal-skin'],['M04',{skin:'terminal'},'terminal-skin'],['D18',{theme:'matrix',skin:'terminal'},'matrix'],['D20',{theme:'contrast'},'contrast'],['D13',{state:'blocked'},'blocked'],['D21',{state:'conflict'},'conflict'],['M16',{state:'offline'},'offline']]){
  await go(id,extra);await page.screenshot({path:path.join(root,'screens/variants',`${id}-${name}.png`)});
 }
 for(const j of journeys){
  for(const view of ['detail','wireframe']){
   await go(j.recovery.screen,{state:j.recovery.state,view});
   await page.screenshot({path:path.join(root,'screens/flows',`${j.id}-recovery${view==='wireframe'?'-wireframe':''}.png`)});
  }
 }

 for(const s of deliveryStages) {
  assert(ids.has(s.screen)&&ids.has(s.mobile),s.id+' missing screen');
  assert(aiProfiles.some(p=>p.id===s.role),s.id+' missing role');
  assert(s.inputs.length&&s.outputs.length&&s.gate&&s.failure,s.id+' incomplete handoff');
 }
 for(const w of handoffs)assert(['inputs','outputs','interface','validation','failure'].every(k=>w.contract[k]),w.id+' incomplete contract');
 await go('D24',{deliveryTab:'release'});
 await page.screenshot({path:path.join(root,'screens/flows/delivery-release.png')});
 await go('D24',{deliveryTab:'recovery'});
 await page.screenshot({path:path.join(root,'screens/flows/delivery-recovery.png')});
 await go('D15',{interactive:'1'});
 await page.locator('#execution-mode').selectOption('team');
 await page.locator('#execution-policy').selectOption('review');
 await page.locator('#execution-mode').selectOption('compare');
 await page.locator('#execution-policy').selectOption('autonomous');
 await page.getByRole('button',{name:'실행 시작',exact:true}).click();
 assert((await page.locator('#dialog').innerText()).includes('후보 비교 · 자율 진행'),'Team mode and progression policy not independent');
 await page.getByRole('button',{name:'닫기',exact:true}).click();
 await page.locator('[data-target="simulate:role-windows"]').click();
 await page.locator('#role-model').selectOption('unsupported');
 await page.locator('[data-profile-save]').click();
 await page.getByRole('button',{name:'닫기',exact:true}).click();
 await page.getByRole('button',{name:'실행 시작',exact:true}).click();
 assert((await page.locator('#dialog').innerText()).includes('설정을 먼저'),'Unsupported model did not block simulated start');
 assert(await page.locator('#modal-confirm').count()===0,'Invalid setup can start');
 await page.getByRole('button',{name:'닫기',exact:true}).click();
 await page.locator('[data-target="simulate:role-windows"]').click();
 await page.locator('#role-model').selectOption('alternate');
 await page.locator('[data-profile-save]').click();
 await page.getByRole('button',{name:'닫기',exact:true}).click();
 await page.locator('[data-target="simulate:role-android"]').click();
 assert(await page.locator('#role-model').inputValue()==='default','Windows override leaked to Android worker');
 await page.getByRole('button',{name:'닫기',exact:true}).click();
 await page.getByRole('button',{name:'실행 시작',exact:true}).click();
 await page.locator('#modal-confirm').click();
 await page.locator('[data-screen-id="D19"]').waitFor();
 report.interactions.push('Role model capability blocks start; team mode and progression policy are independent; recovery restores simulated start.');
 await go('D17',{interactive:'1'});
 await page.locator('[data-target="simulate:retry-attempt"]').first().click();
 await page.locator('#modal-confirm').click();
 assert((await page.locator('.execution-receipt').innerText()).includes('시도 2'),'Retry must create a new attempt');
 await page.locator('[data-target="simulate:stale-evidence"]').click();
 assert((await page.locator('#dialog').innerText()).includes('만료'),'Review expiration missing');
 await page.getByRole('button',{name:'닫기',exact:true}).click();
 report.interactions.push('Task retry keeps distinct attempt identity and evidence expiration exposes revalidation.');
 await go('D19',{interactive:'1'});
 await page.locator('[data-target="simulate:candidate-failed"]').first().click();
 assert((await page.locator('#dialog').innerText()).includes('검증 부족'),'Failed candidate evidence missing');
 await page.getByRole('button',{name:'닫기',exact:true}).click();
 await page.locator('[data-target="simulate:adopt-A"]').first().click();
 assert(page.url().includes('render/D19')&&(await page.locator('.product-body').innerText()).includes('채택됨'),'Adoption should stay separate from integration');
 report.interactions.push('Failed candidate stays inspectable; adoption records selection without integration.');
 await go('D24',{interactive:'1'});
 await page.locator('[data-delivery-tab="release"]').click();
 assert((await page.locator('.product-body').innerText()).includes('출시 준비 미완료'),'Unrun recovery check should block release readiness');
 await page.locator('[data-delivery-tab="recovery"]').click();
 await page.locator('[data-target="simulate:integration-restore"]').click();
 assert((await page.locator('#dialog').innerText()).includes('사용자 작업은 보존'),'Integration recovery should preserve user work');
 await page.getByRole('button',{name:'닫기',exact:true}).click();
 report.interactions.push('Release and recovery views expose missing evidence and preserve the previous successful integration.');
 await go('D36',{interactive:'1'});
 for(const p of aiProfiles){
  await page.locator('#execution-profile').selectOption(p.id);
  assert((await page.locator('.execution-prompt pre').textContent())===p.prompt,'Role settings prompt mismatch: '+p.id);
 }
 await go('M15',{interactive:'1'});
 await page.locator('[data-target="simulate:mobile-profile"]').click();
 await page.locator('#role-model').selectOption('alternate');
 await page.locator('[data-profile-save]').click();
 assert(await page.locator('#role-model').inputValue()==='alternate','Mobile next-run model editing missing');
 const dialogViolations=(await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations;
 report.accessibility.push({screen:'mobile-role-dialog',violations:dialogViolations});
 if(dialogViolations.length)report.issues.push({screen:'mobile-role-dialog',kind:'accessibility',violations:dialogViolations});
 await page.screenshot({path:path.join(root,'screens/flows/delivery-mobile-role.png')});
 await page.getByRole('button',{name:'닫기',exact:true}).click();
 await go('M08',{interactive:'1'});
 await page.locator('[data-target="simulate:mobile-integration"]').click();
 assert((await page.locator('#dialog').innerText()).includes('복구 실증'),'Mobile integration and release readiness missing');
 await page.getByRole('button',{name:'닫기',exact:true}).click();
 report.interactions.push('All eight role prompts are visible in settings and Android exposes supported next-run model choices.');
 for(const size of [[1440,1000],[390,844]]){
  await page.setViewportSize({width:size[0],height:size[1]});
  await portalGo('delivery');
  assert(await page.locator('.delivery-stage').count()===7,'Delivery storyboard stages missing');
  assert(!(await overflow()).document,'Delivery portal overflow');
  report.responsive.push({screen:'delivery',size,overflow:await overflow()});
  await page.screenshot({path:path.join(root,'screens/flows/delivery-'+size.join('x')+'.png')});
 }
 const deliveryViolations=(await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations;
 report.accessibility.push({screen:'delivery-portal',violations:deliveryViolations});
 if(deliveryViolations.length)report.issues.push({screen:'delivery-portal',kind:'accessibility',violations:deliveryViolations});
 report.interactions.push('Seven delivery stages link inputs, role prompts, outputs, gates, recovery and matching desktop/mobile screens.');

 console.log('Checking confirmed policy illustrations and interactions.');
 await verifyPolicies({page,go,portalGo,report,overflow,root,assert});
 console.log('Checking prototype navigation and review persistence.');
 for(const id of ['D06','D10','D18','D20','D21','D22']){
  await go(id,{interactive:'1'});
  assert(await page.locator('.product-nav').count()===1,`${id} must have one contextual sidebar`);
  assert(await page.locator('.product-body .conversation-list,.product-body .review-list,.product-body .file-tree,.product-body .canvas-layout>.layers').count()===0,`${id} still has a second navigation column`);
 }
 report.interactions.push('Conversation, features, canvas, review and editor use one contextual navigation column.');
 await go('D18',{interactive:'1'});
 await page.locator('#chat-draft').fill('First session draft');
 await page.locator('.product-nav [data-session-entry="planning"]').click();
 assert((await page.locator('.conversation-title h1').innerText())==='기획 문서 연결','Session title did not change');
 assert(await page.locator('#chat-draft').inputValue()==='','Another session inherited the first draft');
 await page.locator('#chat-draft').fill('Second session draft');
 await page.locator('.product-nav [data-session-entry="experience"]').click();
 assert(await page.locator('#chat-draft').inputValue()==='First session draft','Returning to a session lost its draft');
 await page.locator('#artifact-toggle').click();
 assert(await page.locator('#conversation-artifact').isVisible(),'Artifact did not open beside the conversation');
 assert(await page.locator('#chat-draft').inputValue()==='First session draft','Opening an artifact lost the draft');
 await page.screenshot({path:path.join(root,'screens/variants','D18-artifact.png')});
 await page.getByRole('button',{name:'대화 스킨 전환',exact:true}).click();
 assert(await page.locator('#conversation-artifact').isVisible(),'Skin switch closed the selected artifact');
 await page.getByRole('button',{name:'산출물 닫기',exact:true}).click();
 assert(await page.locator('#chat-draft').inputValue()==='First session draft','Closing artifact lost the draft');
 report.interactions.push('Session switching restores separate drafts; artifact and skin changes preserve the selected conversation.');
 await go('D18',{interactive:'1'},{width:800,height:600});
 await page.locator('#chat-draft').fill('Narrow conversation draft');
 await page.getByRole('button',{name:'대화 목록 열기',exact:true}).click();
 assert(await page.locator('dialog').isVisible(),'Narrow navigation drawer did not open');
 await page.screenshot({path:path.join(root,'screens/variants','D18-navigation-drawer.png')});
 await page.locator('dialog #conversation-search').fill('기획');
 assert(await page.locator('dialog [data-session-entry]:visible').count()===2,'Conversation filter failed');
 await page.keyboard.press('Escape');
 assert(await page.getByRole('button',{name:'대화 목록 열기',exact:true}).evaluate(el=>el===document.activeElement),'Drawer close did not restore focus');
 assert(await page.locator('#chat-draft').inputValue()==='Narrow conversation draft','Drawer lost the draft');
 await page.locator('#artifact-toggle').click();
 assert(!(await page.locator('.chat-full>.chat-panel').isVisible()),'Narrow artifact should replace the visible pane');
 await page.getByRole('button',{name:'산출물 닫기',exact:true}).click();
 assert(await page.locator('#chat-draft').isVisible(),'Narrow artifact did not return to the conversation');
 assert(await page.locator('#chat-draft').inputValue()==='Narrow conversation draft','Narrow artifact lost the draft');
 report.interactions.push('Narrow list drawer supports search, Escape and focus return; artifact return preserves input.');
 await go('D05',{interactive:'1'},{width:800,height:600});
 await page.locator('[data-pane-choice="chat"]').click();
 await page.locator('#chat-draft').fill('Narrow pane draft');
 await page.locator('[data-pane-choice="artifact"]').click();
 assert(await page.locator('.document-pane').isVisible(),'Artifact pane is not visible');
 await page.locator('[data-pane-choice="chat"]').click();
 assert(await page.locator('#chat-draft').inputValue()==='Narrow pane draft','Narrow pane switch lost draft');
 await page.getByRole('button',{name:'대화 스킨 전환',exact:true}).click();
 assert(await page.locator('#chat-draft').isVisible(),'Skin switch lost active narrow pane');
 report.interactions.push('Narrow desktop panes switch with buttons and preserve the conversation draft.');
 await go('D20');
 assert(await page.locator('.compare-surface').evaluateAll(els=>els.every(el=>el.querySelector('.tiny-mock').getBoundingClientRect().bottom<=el.getBoundingClientRect().bottom)),'Comparison preview escapes its panel');
 await go('D16');
 assert((await page.locator('.header-end').innerText()).includes('작업 진행 중'),'Execution header has wrong context');
 assert((await page.locator('.chat-top').innerText()).includes('대표 AI'),'Execution conversation has wrong context');
 report.interactions.push('Execution context and comparison preview bounds match their screen.');
 await go('D18',{interactive:'1'});
 await page.locator('#chat-draft').fill('스킨 전환 후에도 유지할 입력');
 await page.getByRole('button',{name:'대화 스킨 전환',exact:true}).click();
 assert(await page.locator('#chat-draft').inputValue()==='스킨 전환 후에도 유지할 입력','Skin switch lost draft');
 assert(await page.locator('body').evaluate(el=>el.classList.contains('terminal-skin')),'Terminal skin missing');
 await page.getByRole('button',{name:'예시 메시지 전송',exact:true}).click();
 assert((await page.locator('.chat-scroll').innerText()).includes('스킨 전환 후에도 유지할 입력'),'Example send missing');
 report.interactions.push('Desktop skin switch preserves draft and example send.');
 await go('D10',{interactive:'1'});
 await page.getByRole('button',{name:'선택 영역 수정',exact:true}).click();
 await page.locator('#modal-confirm').click();
 assert((await page.locator('.scene-input').innerText()).includes('하고 싶은 일을'),'Scene edit failed');
 await page.getByRole('button',{name:'실행 취소',exact:true}).click();
 assert((await page.locator('.scene-input').innerText()).includes('원하는 변경'),'Scene undo failed');
 report.interactions.push('Selected scene change and undo.');
 await go('M06',{interactive:'1'});
 await page.getByRole('button',{name:'속성 편집',exact:true}).click();
 await page.getByRole('textbox',{name:'새 안내 문구',exact:true}).fill('Mobile scene edit');
 await page.locator('#modal-confirm').click();
 assert((await page.locator('.scene-input').innerText()).includes('Mobile scene edit'),'Mobile scene edit lost the entered value');
 report.interactions.push('Android selected scene property shows the entered text.');
 await go('D13',{interactive:'1'});
 await page.getByRole('button',{name:'확정본 만들기',exact:true}).click();
 await page.locator('#modal-confirm').click();
 assert(page.url().includes('render/D13'),'Freeze unexpectedly started execution');
 assert((await page.locator('.state-card,.policy-state').innerText()).includes('실행은 실행 준비'),'Freeze/start separation missing');
 await go('D15',{interactive:'1'});
 await page.locator('#execution-mode').selectOption('team');
 await page.locator('#execution-policy').selectOption('review');
 await page.getByRole('button',{name:'실행 시작',exact:true}).click();
 await page.locator('#modal-confirm').click();
 await page.locator('[data-screen-id="D16"]').waitFor();
 report.interactions.push('Design freeze stays in design; explicit simulated start opens task board.');
 await go('M04',{interactive:'1'});
 await page.locator('#chat-draft').fill('모바일 입력');
 await page.locator('#chat-draft').press('Enter');
 assert((await page.locator('#chat-draft').inputValue()).includes('\n'),'Mobile Enter sent instead of newline');
 report.interactions.push('Android Enter inserts a newline.');
 await page.setViewportSize({width:1600,height:1050});
 await page.goto(pageUrl+'#screen/D05');
 await page.locator('#screen-frame').waitFor();
 await page.locator('#review-comment').fill('QA round-trip: 입력과 산출물의 연결 확인');
 await page.locator('#save-comment').click();
 await page.locator('#review-status').selectOption('reviewed');
 await page.reload();
 assert(await page.locator('#review-status').inputValue()==='reviewed','Review status did not persist');
 assert((await page.locator('#screen-comments').innerText()).includes('QA round-trip'),'Review note did not persist');
 const downloadPromise=page.waitForEvent('download');
 await page.locator('[data-export-review]').click();
 const download=await downloadPromise;
 const exported=JSON.parse(await fs.readFile(await download.path(),'utf8'));
 assert(exported.implementationApproved===(meta.implementationApproved===true)&&exported.comments.some(c=>c.text.includes('QA round-trip')),'Review export contract failed');
 await page.evaluate(()=>localStorage.clear());
 await page.reload();
 assert(await page.locator('#review-status').inputValue()==='pending','Fresh review must remain pending');
 await portalGo('reviews');
 await page.locator('#review-file').setInputFiles({name:'review.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...exported,implementationApproved:!meta.implementationApproved,designApproval:{status:'forged-import'}}))});
 await page.locator('#modal-confirm').click();
 await portalGo('screen/D05');
 assert(await page.locator('#review-status').inputValue()==='reviewed','Review import lost screen status');
 assert((await page.locator('#screen-comments').innerText()).includes('QA round-trip'),'Review import lost comment');
 const secondDownload=page.waitForEvent('download');
 await page.locator('[data-export-review]').click();
 const imported=JSON.parse(await fs.readFile(await (await secondDownload).path(),'utf8'));
 assert(imported.implementationApproved===(meta.implementationApproved===true)&&imported.designApproval?.id===meta.approvalId,'Import must never alter durable user authorization');
 await page.evaluate(()=>localStorage.clear());
 await page.reload();
 report.interactions.push('Review JSON round trip preserves notes and ignores imported implementation authorization.');
 report.interactions.push('Review note and status persist; JSON export never authorizes implementation; fresh profile remains pending.');
 await page.evaluate(({version})=>localStorage.setItem('ezterminal-design-review:'+version,JSON.stringify({schemaVersion:1,packageVersion:version,revision:1,implementationApproved:false,screens:{D18:'reviewed',M10:'reviewed'},comments:[{screenId:'D18',text:'Prior revision note',at:'2026-10-12'}]})),{version:meta.version});
 await page.reload();
 await portalGo('screen/D18');
 assert(await page.locator('#review-status').inputValue()==='pending','Changed desktop design must be reviewed again');
 assert((await page.locator('#screen-comments').innerText()).includes('Prior revision note'),'Prior revision comment was lost');
 await portalGo('screen/M10');
 assert(await page.locator('#review-status').inputValue()==='reviewed','Unchanged Android review was lost');
 await page.evaluate(()=>localStorage.clear());
 await page.reload();
 report.interactions.push('Navigation revision preserves prior comments, resets changed Desktop reviews, and retains Android review status.');
 await page.evaluate(({version})=>localStorage.setItem('ezterminal-design-review:'+version,JSON.stringify({packageVersion:version,revision:2,screens:{D18:'reviewed',D21:'reviewed',D15:'reviewed',M04:'reviewed',M10:'reviewed'},comments:[]})),{version:meta.version});
 await page.reload();
 for(const [id,status] of [['D18','pending'],['D21','reviewed'],['D15','pending'],['M04','pending'],['M10','reviewed']]){
  await portalGo('screen/'+id);assert(await page.locator('#review-status').inputValue()===status,'r4 migration lost review scope: '+id);
 }
 await page.evaluate(()=>localStorage.clear());await page.reload();
 report.interactions.push('Revision 4 resets only revised screens and preserves unchanged revision 2 reviews.');
 for(const route of ['overview','prd','features','flows','ai','delivery','policies','screens','design','roadmap','reviews','handoff']){
  await portalGo(route);
  await page.locator('main h1').first().waitFor();
  assert(!(await overflow()).document,`Portal overflow: ${route}`);
 }
 await portalGo('overview');
 await page.screenshot({path:path.join(root,'screens/variants','review-overview.png'),fullPage:true});
 await portalGo('screen/D05');
 await page.frameLocator('#screen-frame').locator('[data-screen-id="D05"]').waitFor();
 await page.screenshot({path:path.join(root,'screens/variants','review-D05.png'),fullPage:true});
 await portalGo('screens');
 report.galleryImages=await page.locator('.screen-gallery img').evaluateAll(imgs=>imgs.filter(img=>img.complete&&img.naturalWidth>0).length);
 assert(report.galleryImages===59,'Not all gallery images decoded');
 await page.screenshot({path:path.join(root,'screens/variants','screen-atlas.png'),fullPage:true});
 console.log('Checking flow storyboards, deep links, preview controls and accessibility.');
 report.flowStoryboards=[];
 for(const j of journeys){
  for(const view of ['detail','wireframe']){
   await portalGo(`flows?journey=${j.id}&view=${view}`);
   const scenes=page.locator('.flow-scene');
   assert(await scenes.count()===j.steps.length+1,`${j.id}: missing storyboard or recovery scene`);
   for(const [index,scene] of j.scenes.entries()){
    assert(await scenes.nth(index).locator('h3').innerText()===scene.title,`${scene.key}: incorrect visit context`);
    assert((await scenes.nth(index).locator('img').getAttribute('src'))===(scene.variant?(view==='wireframe'?scene.wireframe:scene.image):`screens/${view}/${scene.screen}.png`),`${scene.key}: incorrect expected screen`);
   }
   assert(await page.locator('.flow-picker [aria-current="true"]').count()===1,`${j.id}: ambiguous selected journey`);
   assert(await page.locator('.flow-figure figcaption a:not([target="_blank"])').count()===0,'Detail links must preserve the flow page');
   assert(!(await overflow()).document,`${j.id}/${view}: page overflow`);
   report.flowStoryboards.push({journey:j.id,view,steps:j.steps.length,recovery:j.recovery.screen,imagesDecoded:await page.locator('.flow-figure img').count()});
  }
 }
 report.interactions.push('All eight flow storyboards display 48 visit-specific steps and eight recovery scenes in detailed and wireframe views; images decode and detail links preserve context.');
 await portalGo('flows?journey=U05&step=5');
 await page.waitForFunction(()=>document.activeElement?.id==='flow-step-5');
 assert((await page.locator('#flow-step-5 h3').innerText()).includes('수정 결과'),'Repeated browser visit lost its changed purpose');
 await page.reload();
 await page.waitForFunction(()=>document.activeElement?.id==='flow-step-5');
 await page.locator('#flow-step-5 .flow-image-button').click();
 assert(await page.locator('dialog[open] h2').innerText()===journeys[4].scenes[4].title,'Preview did not start at selected step');
 await page.keyboard.press('ArrowLeft');
 assert(await page.locator('dialog[open] h2').innerText()===journeys[4].scenes[3].title,'Preview keyboard previous failed');
 await page.keyboard.press('ArrowRight');
 await page.locator('[data-flow-next]').click();
 assert(await page.locator('[data-flow-next]').isDisabled(),'Final recovery scene should disable next');
 await page.keyboard.press('Escape');
 assert(await page.locator('#flow-step-5 .flow-image-button').evaluate(el=>el===document.activeElement),'Closing preview did not return focus');
 await portalGo('flows?journey=U03&step=2');
 await page.waitForFunction(()=>document.activeElement?.id==='flow-step-2');
 await page.goBack();
 await page.locator('[data-journey="U05"]').waitFor();
 await page.waitForFunction(()=>document.activeElement?.id==='flow-step-5');
 report.interactions.push('Repeated screen visits retain their own purpose; step deep links survive reload and Back; expanded previews support keyboard navigation, boundaries, Escape and focus return.');
 await portalGo('flows?journey=U01');
 await page.locator('#flow-view-wireframe').click();
 await page.locator('#flow-view-wireframe[aria-pressed="true"]').waitFor();
 assert(await page.locator('#flow-view-wireframe').evaluate(el=>el===document.activeElement),'Wireframe switch lost focus');
 assert((await page.locator('#flow-step-1 img').getAttribute('src')).includes('/wireframe/'),'Wireframe switch did not update image');
 await page.locator('.flow-waypoints a').nth(2).click();
 await page.waitForFunction(()=>document.activeElement?.id==='flow-step-3');
 assert(page.url().includes('view=wireframe'),'Step navigation lost display mode');
 await page.locator('.flow-recovery .text-link').click();
 await page.waitForFunction(()=>document.activeElement?.id==='flow-step-10');
 report.interactions.push('Flow display-mode switch retains focus; step links retain display mode; recovery links lead to the specified return step.');
 for(const [journey,size] of [['U01',[390,844]],['U01',[800,600]],['U04',[390,844]],['U04',[800,600]]]){
  await page.setViewportSize({width:size[0],height:size[1]});
  await portalGo(`flows?journey=${journey}&step=2`);
  const layout=await overflow();
  assert(!layout.document,`${journey}/${size}: narrow flow overflow`);
  await page.screenshot({path:path.join(root,'screens/flows',`${journey}-${size.join('x')}.png`)});
  await page.locator('#flow-step-2 .flow-image-button').click();
  const bounds=await page.locator('dialog').boundingBox();
  assert(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=size[0]+1&&bounds.y+bounds.height<=size[1]+1,'Narrow preview does not fit viewport');
  assert(await page.locator('dialog').evaluate(el=>el.scrollHeight<=el.clientHeight+1),'Narrow preview hides controls');
  if(journey==='U04'&&size[0]===390)await page.screenshot({path:path.join(root,'screens/flows','U04-mobile-preview.png')});
  await page.keyboard.press('Escape');
  report.responsive.push({screen:'flows/'+journey,size,overflow:layout});
 }
 await page.setViewportSize({width:1440,height:1000});
 await portalGo('flows');
 await page.evaluate(()=>scrollTo(0,0));
 await page.screenshot({path:path.join(root,'screens/flows','review-flows.png')});
 await portalGo('flows?journey=U01&step=3');
 await page.waitForFunction(()=>document.activeElement?.id==='flow-step-3');
 await page.screenshot({path:path.join(root,'screens/flows','U01-step03.png')});
 for(const [name,journey,preview,size] of [['flow-storyboard','U01',false,[1440,1000]],['flow-preview','U01',true,[1440,1000]],['flow-android','U04',false,[390,844]]]){
  await page.setViewportSize({width:size[0],height:size[1]});
  await portalGo(`flows?journey=${journey}&step=2`);
  if(preview)await page.locator('#flow-step-2 .flow-image-button').click();
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  const violations=result.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));
  report.accessibility.push({screen:name,violations});
  if(violations.length)report.issues.push({screen:name,kind:'accessibility',violations});
  if(preview)await page.keyboard.press('Escape');
 }
 await page.setViewportSize({width:1440,height:1000});
 await portalGo('ai');
 const reviewBefore=await page.evaluate(()=>JSON.stringify(localStorage));
 for(const profile of aiProfiles){
  await page.locator(`.ai-profile-picker a[href="#ai?profile=${profile.id}"]`).click();
  await page.locator(`[data-profile="${profile.id}"]`).waitFor();
  assert((await page.locator('.ai-prompt-text').innerText())===profile.prompt,`Incorrect role prompt: ${profile.id}`);
  assert(!(await overflow()).document,'AI profile portal overflow');
 }
 assert(await page.evaluate(()=>JSON.stringify(localStorage))===reviewBefore,'Browsing AI profiles mutated review or execution configuration');
 await portalGo('flows?journey=U01&step=3');
 await page.locator('#flow-step-3 .flow-ai-detail summary').click();
 assert(await page.locator('#flow-step-3 .flow-ai-detail').getAttribute('open')!==null,'Flow AI details did not expand');
 assert((await page.locator('#flow-step-3 .flow-ai-detail a').getAttribute('href'))==='#ai?profile=planning','Flow role link incorrect');
 await portalGo('flows?journey=U06');
 assert(await page.locator('.flow-ai-detail').count()===0,'Terminal flow must not imply AI execution');
 report.interactions.push('Eight role profiles expose their own prompt; profile browsing does not mutate settings or review; flow role links distinguish optional AI from manual terminal work.');
 for(const size of [[1440,1000],[390,844]]){
  await page.setViewportSize({width:size[0],height:size[1]});
  await portalGo('ai?profile=coordinator');
  const layout=await overflow();
  assert(!layout.document,'AI profile proposal overflow at '+size[0]);
  report.responsive.push({screen:'ai/coordinator',size,overflow:layout});
  await page.screenshot({path:path.join(root,'screens/flows',`ai-profile-${size.join('x')}.png`)});
 }
 await page.setViewportSize({width:1440,height:1000});
 await portalGo('ai');await page.evaluate(()=>scrollTo(0,0));
 await page.screenshot({path:path.join(root,'screens/flows','ai-operating.png')});
 const aiAxe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
 const aiViolations=aiAxe.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));
 report.accessibility.push({screen:'ai-operating',violations:aiViolations});
 if(aiViolations.length)report.issues.push({screen:'ai-operating',kind:'accessibility',violations:aiViolations});
 console.log('Checking accessibility on representative screens.');
 for(const id of ['D05','D10','D15','D17','D18','D19','D20','D24','D36','D38','M04','M06','M07','M08','M15']){
  await go(id,{interactive:'1'});
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  const violations=result.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));
  report.accessibility.push({screen:id,violations});
  if(violations.length)report.issues.push({screen:id,kind:'accessibility',violations});
 }
 await verifyTerminalSkin({context,root,report});
 assert(externalRequests.length===0,`Unexpected external requests: ${externalRequests.join(', ')}`);
 assert(consoleErrors.length===0,`Browser script errors: ${consoleErrors.join(', ')}`);
 report.externalRequests=externalRequests;report.browserErrors=consoleErrors;
 const names=['design-approval.mjs','build.mjs','policy-planning.mjs','policy-ui.js','profile-ui.js','build-policies.mjs','verify-policies.mjs','terminal-skin.js','chat-skin-review.js','verify-terminal-skin.mjs','content.mjs','ai-planning.mjs','delivery-planning.mjs','delivery-ui.js','build-delivery.mjs','prototype.js','prototype.css','index.html','data.js','catalog.json'];
 report.sourceHashes={};for(const name of names)report.sourceHashes[name]=crypto.createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex');
 report.result=report.issues.length?'needs-fixes':'passed';
 await fs.writeFile(path.join(root,'qa-report.json'),JSON.stringify(report,null,2)+'\n');
 await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({schemaVersion:1,...meta,canonical:'content.mjs',prototype:'index.html',visualValues:'prototype.css',runtimeMappings:'DESIGN.md and docs/ux/frontend-design.md section 16; reference CSS values are not runtime tokens',userReview:'r6 whole-design-approved; individual clicks not asserted',sourceHashes:report.sourceHashes,screens:report.screens.map(s=>({id:s.id,detail:s.detail,wireframe:s.wireframe})),qaReport:'qa-report.json'},null,2)+'\n');
 console.log(JSON.stringify({result:report.result,screens:report.screens.length,stateChecks:report.states.length,responsiveChecks:report.responsive.length,interactionChecks:report.interactions.length,accessibilityChecks:report.accessibility.length,issues:report.issues.length}));
 if(report.issues.length)process.exitCode=1;
}catch(error){report.result='failed';report.issues.push({kind:'exception',message:error.message});await fs.writeFile(path.join(root,'qa-report.json'),JSON.stringify(report,null,2)+'\n');console.error(error);process.exitCode=1;}finally{await browser.close();}
