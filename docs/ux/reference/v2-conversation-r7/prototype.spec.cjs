const {test,expect}=require('@playwright/test');
const AxeBuilder=require('@axe-core/playwright').default;
const path=require('node:path');
const fs=require('node:fs');
const evidence=path.join(__dirname,'evidence');
const iframe=(p,id='main')=>p.locator(`iframe[data-session-frame="${id}"]`);
const frame=(p,id='main')=>p.frameLocator(`iframe[data-session-frame="${id}"]`);
const state=p=>p.evaluate(()=>workbenchDemo.getState());
const snap=(p,id='main')=>iframe(p,id).evaluate(e=>e.contentWindow.paneAPI.snapshot());
async function ready(p){await p.waitForFunction(()=>window.workbenchDemo&&[...document.querySelectorAll('iframe')].every(e=>e.contentWindow?.paneAPI));}
async function start(p){await p.goto('/');await ready(p);}
async function shot(p,name){await p.screenshot({path:path.join(evidence,name+'.png')});}
async function activeFrame(p){return frame(p,(await state(p)).active);}
test('layout and workspace changes keep conversation instances, drafts, queue and reading state',async({page})=>{
  await start(page);const f=frame(page);
  await f.locator('#prompt').fill('분할과 창을 옮겨도 유지할 초안');
  await f.locator('#file-input').setInputFiles({name:'composer-review.txt',mimeType:'text/plain',buffer:Buffer.from('proposal fixture')});
  await f.locator('[data-action="reply"]').first().click();
  await iframe(page).evaluate(e=>{const w=e.contentWindow;w.instanceMarker='same-pane';const p=w.document.querySelector('#prompt');p.setSelectionRange(3,8);w.document.querySelector('#transcript').scrollTop=80;});
  const before=await snap(page);
  const qBefore=(await snap(page,'mobile')).queue;
  for(const layout of ['rows','triple','single','columns']){
    await page.locator(`[data-layout="${layout}"]`).click();await ready(page);
    await expect(f.locator('#prompt')).toHaveValue(before.data.draft);
    const after=await snap(page);expect(after.data.quote).toEqual(before.data.quote);expect(after.data.attachments).toEqual(before.data.attachments);expect(after.view.selectionStart).toBe(3);expect(after.view.selectionEnd).toBe(8);
    expect(await iframe(page).evaluate(e=>e.contentWindow.instanceMarker)).toBe('same-pane');
    expect((await snap(page,'mobile')).queue).toEqual(qBefore);
  }
  await page.locator('[data-space="review"]').click();await expect(iframe(page)).toBeHidden();
  await page.locator('[data-space="chat"]').click();await expect(f.locator('#prompt')).toHaveValue(before.data.draft);
  await page.reload();await ready(page);await expect(f.locator('#prompt')).toHaveValue(before.data.draft);expect((await snap(page)).data.quote).toEqual(before.data.quote);
});

test('real auxiliary windows preserve drafts and approval, split locally and return on close',async({page})=>{
  await start(page);await page.selectOption('#active-scenario','approval');
  await frame(page).locator('#prompt').fill('별도 창으로 가져갈 초안');
  await frame(page).locator('#file-input').setInputFiles({name:'window-state.txt',mimeType:'text/plain',buffer:Buffer.from('proposal fixture')});
  await frame(page).locator('[data-action="reply"]').first().click();
  await iframe(page).evaluate(e=>{const d=e.contentDocument;d.querySelector('#prompt').setSelectionRange(2,5);d.querySelector('#transcript').scrollTop=24;});const before=await snap(page);
  const popupEvent=page.waitForEvent('popup');await page.locator('[data-action="detach"]').click();const popup=await popupEvent;await ready(popup);
  await expect(iframe(page)).toBeHidden();await expect(frame(popup).locator('#prompt')).toHaveValue('별도 창으로 가져갈 초안');await expect(frame(popup).locator('[data-action="allow"]')).toBeVisible();
  const moved=await snap(popup);expect(moved.data.attachments).toEqual(before.data.attachments);expect(moved.data.quote).toEqual(before.data.quote);expect(moved.view.selectionStart).toBe(2);expect(moved.view.selectionEnd).toBe(5);expect(moved.view.scroll).toBe(before.view.scroll);
  await frame(popup).locator('[data-action="allow"]').click();await frame(popup).locator('#prompt').fill('별도 창에서 수정한 초안');
  const mainPaneCount=await page.locator('.wb-group').count();await popup.locator('[data-layout="columns"]').click();await ready(popup);expect(await popup.locator('.wb-group').count()).toBe(2);expect(await page.locator('.wb-group').count()).toBe(mainPaneCount);expect((await state(page)).model.detached.mobile).toBeUndefined();await expect(iframe(page,'mobile')).toBeVisible();
  await shot(popup,'proposal-auxiliary-columns');await popup.locator('[data-action="return-all"]').click();
  await expect(frame(page).locator('#prompt')).toHaveValue('별도 창에서 수정한 초안');await expect(frame(page).locator('.approval-receipt')).toContainText('허용');expect((await snap(page)).state).toBe('working');
  await page.locator('[data-tab="main"]').click();const next=page.waitForEvent('popup');await page.locator('[data-action="detach"]').click();const p2=await next;await ready(p2);await frame(p2).locator('#prompt').fill('창 닫기로 복구한 초안');await p2.close({runBeforeUnload:true});
  await expect(frame(page).locator('#prompt')).toHaveValue('창 닫기로 복구한 초안',{timeout:10000});
});

test('popup blocking leaves the original pane intact',async({page})=>{
  await start(page);await frame(page).locator('#prompt').fill('차단되어도 보관');await page.evaluate(()=>window.open=()=>null);await page.locator('[data-action="detach"]').click();await expect(page.locator('#wb-dialog')).toContainText('팝업이 차단');expect(Object.keys((await state(page)).model.detached)).toHaveLength(0);await page.keyboard.press('Escape');await expect(frame(page).locator('#prompt')).toHaveValue('차단되어도 보관');
});

test('tab drag, group drag, keyboard menus and resizers offer equivalent movement',async({page})=>{
  await start(page);await frame(page).locator('#prompt').fill('드래그 후 초안');
  const transfer=await page.evaluateHandle(()=>new DataTransfer());
  await page.locator('[data-tab="mobile"]').dispatchEvent('dragstart',{dataTransfer:transfer});
  await page.locator('[data-drop-group="left"][data-edge="center"]').dispatchEvent('drop',{dataTransfer:transfer});
  await expect(page.locator('[data-group="left"] [data-tab]')).toHaveCount(2);
  await page.locator('[data-tab="main"]').focus();await page.keyboard.press('Shift+F10');await expect(page.locator('#wb-dialog')).toBeVisible();await page.locator('[data-menu-action="below"]').click();await expect(frame(page).locator('#prompt')).toHaveValue('드래그 후 초안');
  const groups=(await state(page)).model.groups;const target=Object.values(groups).find(g=>g.tabs.includes('main')).id;const from=Object.values(groups).find(g=>g.tabs.includes('mobile')).id;
  await page.locator(`[data-group-drag="${from}"]`).dispatchEvent('dragstart',{dataTransfer:transfer});await page.locator(`[data-drop-group="${target}"][data-edge="center"]`).dispatchEvent('drop',{dataTransfer:transfer});
  await expect(page.locator(`[data-group="${target}"] [data-tab]`)).toHaveCount(2);
  await page.locator('[data-layout="columns"]').click();const divider=page.locator('[data-divider]').first();const before=Number(await divider.getAttribute('aria-valuenow'));await divider.focus();await divider.press('ArrowRight');expect(Number(await divider.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
  const box=await divider.boundingBox();await page.mouse.move(box.x+4,box.y+20);await page.mouse.down();await page.mouse.move(450,box.y+20,{steps:8});await page.mouse.up();
  for(const f of await page.locator('iframe:visible').all())expect((await f.boundingBox()).width).toBeGreaterThan(320);
  await shot(page,'proposal-narrow-desktop-pane');
});

test('desktop narrow panes send with Enter while mobile Enter inserts a newline',async({browser,page})=>{
  await start(page);await page.locator('[data-layout="columns"]').click();const divider=page.locator('[data-divider]').first();const box=await divider.boundingBox();await page.mouse.move(box.x+4,box.y+20);await page.mouse.down();await page.mouse.move(450,box.y+20);await page.mouse.up();
  await frame(page).locator('#prompt').fill('좁은 PC 영역 전송');await frame(page).locator('#prompt').press('Enter');await expect(frame(page).locator('#prompt')).toHaveValue('');await expect(frame(page).locator('#messages')).toContainText('좁은 PC 영역 전송');
  const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const mp=await mobile.newPage();await mp.goto('http://127.0.0.1:4317');await ready(mp);await frame(mp).locator('#prompt').fill('모바일 줄바꿈');await frame(mp).locator('#prompt').press('Enter');await expect(frame(mp).locator('#prompt')).toHaveValue('모바일 줄바꿈\n');await frame(mp).locator('#send').click();await expect(frame(mp).locator('#prompt')).toHaveValue('');await mobile.close();
});

test('all responsive states keep send controls inside each pane; narrow layouts retain their splits',async({browser})=>{
  const metrics=[],errors=[];
  for(const [name,width,height,touch] of [['desktop',1440,900,false],['wide',1920,1080,false],['tablet',1024,768,false],['mobile',390,844,true],['small',320,640,true]]){
    const context=await browser.newContext({viewport:{width,height},hasTouch:touch,isMobile:touch});const p=await context.newPage();p.on('pageerror',e=>errors.push(name+': '+e.message));await p.goto('http://127.0.0.1:4317');await ready(p);
    for(const layout of ['columns','rows','triple']){
      await p.locator(`[data-layout="${layout}"]`).click();await ready(p);
      for(const scenario of ['completed','working','approval','error','offline','empty','uncertain','conflict','stopped','loading']){
        await p.selectOption('#active-scenario',scenario);
        const values=await p.evaluate(()=>({width:innerWidth,docWidth:document.documentElement.scrollWidth,height:innerHeight,docHeight:document.documentElement.scrollHeight,frames:[...document.querySelectorAll('iframe:not([hidden])')].map(e=>{const d=e.contentDocument,w=e.contentWindow;return {id:e.dataset.sessionFrame,width:w.innerWidth,height:w.innerHeight,docWidth:d.documentElement.scrollWidth,send:d.querySelector('#send').getBoundingClientRect().toJSON(),transcript:d.querySelector('#transcript').getBoundingClientRect().toJSON()};})}));
        expect(values.docWidth,`${name}/${layout}/${scenario} host overflow`).toBeLessThanOrEqual(width);expect(values.docHeight).toBeLessThanOrEqual(height);
        for(const v of values.frames){expect(v.docWidth,`${name}/${layout}/${scenario} frame overflow`).toBeLessThanOrEqual(v.width);expect(v.send.right,`${name}/${layout}/${scenario} send x`).toBeLessThanOrEqual(v.width+1);expect(v.send.bottom,`${name}/${layout}/${scenario} send y`).toBeLessThanOrEqual(v.height+1);expect(v.send.top).toBeGreaterThanOrEqual(0);expect(v.transcript.height,`${name}/${layout}/${scenario} transcript`).toBeGreaterThan(55);}
        metrics.push({name,layout,scenario,...values});
      }
      await p.selectOption('#active-scenario','completed');await shot(p,`proposal-${name}-${layout}`);
    }
    if(width===390){expect((await state(p)).compact).toBe(true);await p.setViewportSize({width:1440,height:900});await expect(p.locator('.wb-group')).toHaveCount(3);await p.setViewportSize({width,height});}
    await context.close();
  }
  fs.writeFileSync(path.join(evidence,'responsive-metrics.json'),JSON.stringify(metrics,null,2));expect(errors).toEqual([]);
});

test('light theme, approval in a secondary pane, inspector and keyboard focus remain usable',async({page})=>{
  await start(page);await page.locator('[data-tab="mobile"]').click();await page.selectOption('#active-scenario','approval');await expect(frame(page,'mobile').locator('[data-action="allow"]')).toBeVisible();await frame(page,'mobile').locator('[data-action="deny"]').click();await expect(frame(page,'mobile').locator('.approval-receipt')).toContainText('거절');
  await page.locator('[data-action="theme"]').click();await shot(page,'proposal-desktop-light');
  await page.locator('[data-review-in="right"]').click();await expect(frame(page,'mobile').locator('#inspector')).toBeVisible();await expect(frame(page,'mobile').locator('.chat-column')).toHaveAttribute('inert','');await frame(page,'mobile').locator('[data-action="close-inspector"]').click();
  await frame(page,'mobile').locator('#prompt').press('Control+Alt+ArrowLeft');await expect(frame(page).locator('#prompt')).toBeFocused();
  await frame(page).locator('#prompt').press('Control+n');await expect(page.locator('[data-group="left"] [data-tab]')).toHaveCount(2);
});

test('automated accessibility review covers host and embedded conversation frames',async({page})=>{
  const results=[];await start(page);
  for(const [name,layout,theme,width,height] of [['columns','columns','dark',1440,900],['triple','triple','dark',1440,900],['light','columns','light',1440,900],['mobile','columns','dark',390,844]]){
    await page.setViewportSize({width,height});await page.evaluate(theme=>workbenchDemo.theme(theme),theme);await page.locator(`[data-layout="${layout}"]`).click();await ready(page);
    const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();results.push({name,violations:result.violations});
  }
  fs.writeFileSync(path.join(evidence,'accessibility.json'),JSON.stringify(results,null,2));expect(results.flatMap(r=>r.violations.map(v=>({name:r.name,id:v.id,nodes:v.nodes.map(n=>n.target)})))).toEqual([]);
});
