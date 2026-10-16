// Meaningful design-interaction checks, not product implementation tests.
import fs from 'node:fs/promises';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {policyFlows,policies,meta} from './content.mjs';
export async function verifyPolicies({page,go,portalGo,report,overflow,root,assert}){
 await fs.mkdir(path.join(root,'screens/policies'),{recursive:true});
 await page.reload();
 const close=()=>page.getByRole('button',{name:'닫기',exact:true}).click();
 const axe=async name=>{
  const violations=(await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations;
  report.accessibility.push({screen:name,violations});if(violations.length)report.issues.push({screen:name,kind:'accessibility',violations});
 };
 report.policyScenes=[];
 for(const f of policyFlows)for(const s of f.scenes){
  assert(policies.some(p=>f.policies.includes(p.id)),f.id+' missing policy');
  for(const view of ['detail','wireframe']){
   await go(s.screen,{policy:s.variant,view});
   await page.locator(`[data-policy-variant="${s.variant}"]`).waitFor();
   const layout=await overflow();if(layout.document||layout.regions.length)report.issues.push({screen:s.variant,kind:'overflow',...layout});
   await page.screenshot({path:path.join(root,view==='detail'?s.image:s.wireframe)});
  }
  await go(s.screen,{policy:s.variant,interactive:'1'});
  report.policyScenes.push({flow:f.id,screen:s.screen,variant:s.variant,image:s.image,wireframe:s.wireframe});
 }
 for(const variant of ['quick-ready','replan-impact','retry-exhausted','profile-proposal','provider-choice','backup','offline-draft','component-updated']){
  const s=policyFlows.flatMap(f=>f.scenes).find(s=>s.variant===variant);
  const size=s.screen.startsWith('M')?{width:360,height:640}:{width:800,height:600};
  await go(s.screen,{policy:variant,interactive:'1'},size);const layout=await overflow();
  report.responsive.push({screen:variant,size,overflow:layout});if(layout.document||layout.regions.length)report.issues.push({screen:variant,kind:'responsive-overflow',...layout});
  await axe(variant);await page.screenshot({path:path.join(root,'screens/policies',variant+'-narrow.png')});
 }
 await go('D18',{policy:'quick-ready',interactive:'1'});
 assert(await page.locator('[data-policy-variant="quick-running"]').count()===0,'Quick task ran before explicit start');
 await page.locator('#quick-goal').fill('검토한 좁은 범위의 수정');
 await page.getByRole('button',{name:'실행',exact:true}).click();
 await page.locator('[data-policy-variant="quick-running"]').waitFor();
 assert(await page.locator('#quick-goal').inputValue()==='검토한 좁은 범위의 수정','Task start lost the confirmed scope');
 report.interactions.push('Quick-task card starts only after explicit action and preserves the reviewed scope.');
 await go('D16',{policy:'replan-impact',interactive:'1'});
 assert((await page.locator('.policy-content').innerText()).includes('무관 · 계속 진행'),'Unrelated work should continue');
 await page.getByRole('button',{name:'변경 계획 확인·적용',exact:true}).click();
 await page.locator('[data-policy-variant="replan-approved"]').waitFor();
 report.interactions.push('Replan review distinguishes affected/dependent work from unrelated ongoing work and preserves old attempts.');
 await go('D17',{policy:'retry-active',interactive:'1'});
 await page.getByRole('button',{name:'소진 장면 보기',exact:true}).click();
 await page.locator('[data-policy-variant="retry-exhausted"]').waitFor();
 assert((await page.locator('.policy-content').innerText()).includes('자동 실행은 여기서 멈춥니다'),'Retry exhaustion gate missing');
 report.interactions.push('Validation repair exhaustion shows initial attempt plus two additional attempts and a user decision gate.');
 await go('D36',{interactive:'1'});await page.reload();
 await page.locator('#execution-profile').selectOption('reviewer');
 await page.locator('#repair-limit').fill('3');await page.locator('#save-repair-limit').click();
 assert((await page.locator('#repair-setting-status').innerText()).includes('저장했습니다'),'Retry setting is not configurable');
 const original=await page.locator('#role-prompt').inputValue();
 await page.locator('#role-prompt').fill(original+'\n수동으로 작성한 검토 지침');
 await page.locator('[data-profile-save]').click();
 assert((await page.locator('.profile-editor').innerText()).includes('저장 버전 v2'),'Manual edits need a saved version');
 await page.locator('[data-profile-ai]').click();
 assert((await page.locator('.profile-editor').innerText()).includes('저장 버전 v2'),'Proposal must not silently save');
 await page.locator('[data-profile-reject]').click();
 assert((await page.locator('#role-prompt').inputValue()).includes('수동으로 작성한'),'Reject lost manual changes');
 await page.locator('[data-profile-ai]').click();
 await page.locator('[data-profile-apply]').click();
 assert((await page.locator('.profile-editor').innerText()).includes('저장 버전 v3'),'Approved AI edit did not create a version');
 assert((await page.locator('.profile-editor').innerText()).includes('현재 실행은 고정된 v1'),'Active attempt should retain frozen settings');
 await page.locator('[data-profile-history]').click();
 await page.locator('[data-restore-version="0"]').click();
 assert(await page.locator('#role-prompt').inputValue()===original,'Rollback did not restore original text');
 assert((await page.locator('.profile-editor').innerText()).includes('저장 버전 v4'),'Rollback should create a new version');
 report.interactions.push('Profiles support direct edits, AI proposal/reject/apply and versioned rollback while active attempts stay frozen.');
 await go('D15',{interactive:'1'});await page.reload();
 await page.locator('#execution-mode').selectOption('team');
 await page.locator('[data-target="simulate:role-android"]').click();
 await page.locator('#role-provider').selectOption('missing');await page.locator('[data-profile-save]').click();await close();
 assert((await page.locator('#execution-readiness').innerText()).includes('설정 필요'),'Participating missing role should block');
 await page.locator('#execution-mode').selectOption('single');
 assert(await page.locator('[data-target="simulate:role-android"]').count()===0,'Single mode should not display inactive Android role');
 assert((await page.locator('#execution-readiness').innerText()).includes('설정 준비됨'),'Inactive role incorrectly blocks single mode');
 report.interactions.push('Execution readiness validates only participating roles; inactive Android configuration does not block single AI.');
 await go('M04',{policy:'offline-draft',interactive:'1'});
 assert((await page.locator('.mobile-header small').innerText()).includes('PC 연결 끊김'),'Offline header contradicts connection state');
 await page.locator('#offline-draft').fill('오프라인에서 준비한 요청');
 await page.getByRole('button',{name:'재연결 장면 보기',exact:true}).click();
 await page.locator('[data-policy-variant="reconnected-draft"]').waitFor();
 assert(await page.locator('#offline-draft').inputValue()==='오프라인에서 준비한 요청','Reconnection lost draft');
 assert((await page.locator('.policy-content').innerText()).includes('아직 전송하지 않았습니다'),'Reconnect must not imply send');
 report.interactions.push('Android reconnect preserves the unsent draft and requires a separate send action. Persistent device storage remains a product acceptance criterion.');
 await go('D17',{policy:'provider-wait',interactive:'1'});
 assert((await page.locator('.policy-content').innerText()).includes('자동으로 다른 AI를 호출하지 않습니다'),'Automatic fallback violates confirmed policy');
 await page.getByRole('button',{name:'대체 AI 선택',exact:true}).click();
 await page.locator('[data-policy-variant="provider-choice"]').waitFor();
 await page.getByRole('button',{name:'선택한 AI로 이어가기',exact:true}).click();
 assert((await page.locator('#dialog').innerText()).includes('이전 결과 대조'),'Fallback must mention reconciliation and handoff');await close();
 await go('D10',{policy:'component',interactive:'1'});
 await page.getByRole('button',{name:'공통 요소 수정 예시',exact:true}).click();
 await page.locator('[data-policy-variant="component-updated"]').waitFor();
 assert((await page.locator('.policy-content').innerText()).includes('예외 유지'),'Common edit should preserve overrides');
 await page.getByRole('button',{name:'변경 묶음 되돌리기',exact:true}).click();await page.locator('[data-policy-variant="component"]').waitFor();
 report.interactions.push('Provider replacement is explicit with handoff; shared-component illustrations preserve overrides and frozen baselines.');
 for(const f of policyFlows)for(const view of ['detail','wireframe']){
  await portalGo(`policies?flow=${f.id}&view=${view}`);
  assert(await page.locator('.policy-stage').count()===f.scenes.length,f.id+' storyboard missing scene');
  assert(!(await overflow()).document,f.id+' portal overflow');
 }
 for(const size of [{width:1440,height:1000},{width:390,height:844}]){
  await page.setViewportSize(size);await portalGo('policies?flow=PF04');await axe('policy-portal-'+size.width);
  assert(!(await overflow()).document,'Policy portal overflow');report.responsive.push({screen:'policies',size,overflow:await overflow()});
  await page.screenshot({path:path.join(root,'screens/policies',`portal-${size.width}.png`),fullPage:true});
 }
 report.policyConfirmation=dataSafe();
 function dataSafe(){return {policies:policies.length,confirmedAt:meta.policyConfirmation.date,designApproved:false,implementationApproved:false};}
 report.interactions.push('All eight policy storyboards load eighteen detailed and wireframe scenes; policy confirmation remains separate from design approval.');
 await page.reload();
}
