const {test,expect}=require('@playwright/test');
const AxeBuilder=require('@axe-core/playwright').default;
const path=require('node:path'),fs=require('node:fs');
const evidence=path.join(__dirname,'evidence','terminal');fs.mkdirSync(evidence,{recursive:true});
const getState=p=>p.evaluate(()=>workbenchDemo.getState());
const iframe=(p,id)=>p.locator(`iframe[data-session-frame="${id}"]`);
const pane=(p,id)=>p.frameLocator(`iframe[data-session-frame="${id}"]`);
const ready=p=>p.waitForFunction(()=>window.workbenchDemo&&[...document.querySelectorAll('.wb-frame')].every(e=>e.contentWindow.paneAPI));
async function start(p){await p.goto('/');await ready(p);}
async function create(p){await p.locator('.wb-new-terminal').click();await ready(p);return (await getState(p)).active;}
test('project terminal opens beside New conversation and preserves mixed tabs, command input and output',async({page})=>{
 await start(page);await pane(page,'main').locator('#prompt').fill('대화에 남겨 둘 초안');
 const chat=await page.locator('.wb-create-row [data-action="new"]').boundingBox(),terminal=await page.locator('.wb-new-terminal').boundingBox();expect(terminal.y).toBe(chat.y);expect(terminal.x).toBeGreaterThan(chat.x);
 const id=await create(page),f=pane(page,id);await expect(f.locator('#terminal-cwd')).toHaveText('C:\\Working\\EZTerminal');expect((await getState(page)).catalog[id]).toMatchObject({kind:'terminal',projectId:'ezterminal',workspaceId:'main',provider:'PowerShell'});
 await expect(f.locator('#terminal-input')).toBeFocused();
 await expect(page.locator('#active-scenario')).toBeHidden();await expect(f.locator('.terminal-demo')).toContainText('실제로 실행되지 않습니다');
 await f.locator('#terminal-input').fill('pwd');await f.locator('#terminal-input').press('Enter');await expect(f.locator('#terminal-output')).toContainText('C:\\Working\\EZTerminal');await expect(f.locator('#terminal-output')).toContainText('예시 출력');
 await f.locator('#terminal-input').fill('pnpm dev');await f.locator('#terminal-input').press('Enter');await expect(f.locator('#terminal-output')).toContainText('셸 명령을 실행하지 않습니다');await f.locator('#terminal-input').press('ArrowUp');await expect(f.locator('#terminal-input')).toHaveValue('pnpm dev');
 await iframe(page,id).evaluate(e=>{e.contentWindow.marker='persistent-terminal';e.contentDocument.querySelector('#terminal-input').setSelectionRange(2,6);});
 await page.locator('[data-layout="columns"]').click();await ready(page);await expect(f.locator('#terminal-input')).toHaveValue('pnpm dev');expect(await iframe(page,id).evaluate(e=>e.contentWindow.marker)).toBe('persistent-terminal');
 await page.locator('[data-session="main"]').click();await expect(pane(page,'main').locator('#prompt')).toHaveValue('대화에 남겨 둘 초안');await page.locator(`[data-session="${id}"]`).click();
 await page.locator('[data-layout="columns"]').click();await ready(page);await page.screenshot({path:path.join(evidence,'desktop-chat-terminal.png')});
 await page.reload();await ready(page);await expect(f.locator('#terminal-input')).toHaveValue('pnpm dev');await expect(f.locator('#terminal-output')).toContainText('셸 명령을 실행하지 않습니다');
 const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();fs.writeFileSync(path.join(evidence,'accessibility-desktop.json'),JSON.stringify(axe.violations,null,2));expect(axe.violations).toEqual([]);
});
test('terminal moves through drag and auxiliary windows without losing project, history or draft',async({page})=>{
 await start(page);const id=await create(page),f=pane(page,id);await f.locator('#terminal-input').fill('git status');await f.locator('#terminal-input').press('Enter');await f.locator('#terminal-input').fill('명령 초안 유지');
 const transfer=await page.evaluateHandle(()=>new DataTransfer());await page.locator(`[data-tab="${id}"]`).dispatchEvent('dragstart',{dataTransfer:transfer});await page.locator('[data-drop-group="right"][data-edge="center"]').dispatchEvent('drop',{dataTransfer:transfer});await expect(f.locator('#terminal-input')).toHaveValue('명령 초안 유지');
 const opened=page.waitForEvent('popup');await page.locator('[data-action="detach"]').click();const popup=await opened;await ready(popup);await expect(pane(popup,id).locator('#terminal-input')).toHaveValue('명령 초안 유지');await expect(pane(popup,id).locator('#terminal-output')).toContainText('실제 Git 상태를 조회하지 않습니다');await expect(pane(popup,id).locator('#terminal-cwd')).toHaveText('C:\\Working\\EZTerminal');
 await pane(popup,id).locator('#terminal-input').fill('별도 창의 터미널 초안');await popup.locator('[data-layout="columns"]').click();await ready(popup);await popup.screenshot({path:path.join(evidence,'auxiliary-terminal.png')});await popup.locator('[data-action="return-all"]').click();await expect(f.locator('#terminal-input')).toHaveValue('별도 창의 터미널 초안');
 expect((await getState(page)).catalog[id].kind).toBe('terminal');await expect(page.locator(`[data-tab="${id}"] svg`)).toBeVisible();
});
test('compact project drawer and pane menu create usable terminals; light and small panes remain accessible',async({browser,page})=>{
 await start(page);await page.locator('[data-menu-in="left"]').click();await page.locator('[data-menu-action="terminal-right"]').click();await ready(page);const id=(await getState(page)).active;expect((await getState(page)).catalog[id].kind).toBe('terminal');
 await page.locator('[data-action="theme"]').click();await page.screenshot({path:path.join(evidence,'desktop-terminal-light.png')});
 const light=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(light.violations).toEqual([]);
 const results=[];
 for(const [width,height] of [[320,640],[390,844],[800,600]]){
  const c=await browser.newContext({viewport:{width,height},isMobile:width<600,hasTouch:width<600});const p=await c.newPage();await p.goto('http://127.0.0.1:4317');await ready(p);
  if(width<700)await p.locator('.wb-mobile-menu').click();else await p.locator('.wb-rail [data-action="sidebar"]').click();
  const t=await create(p),f=pane(p,t);await expect(p.locator('.wb-sidebar')).not.toHaveClass(/open/);await expect(f.locator('#terminal-input')).toBeVisible();await f.locator('#terminal-input').fill('help');await f.locator('[type="submit"]').click();await expect(f.locator('#terminal-output')).toContainText('예시 명령');
  const m=await iframe(p,t).evaluate(e=>{const w=e.contentWindow,d=e.contentDocument;return {width:w.innerWidth,height:w.innerHeight,docWidth:d.documentElement.scrollWidth,input:d.querySelector('#terminal-input').getBoundingClientRect().toJSON(),button:d.querySelector('[type="submit"]').getBoundingClientRect().toJSON()};});expect(m.docWidth).toBeLessThanOrEqual(m.width);expect(m.button.right).toBeLessThanOrEqual(m.width);expect(m.button.bottom).toBeLessThanOrEqual(m.height);expect(m.input.width).toBeGreaterThan(100);
  await p.screenshot({path:path.join(evidence,`terminal-${width}.png`)});const a=await new AxeBuilder({page:p}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();results.push({width,violations:a.violations,metrics:m});await c.close();
 }
 fs.writeFileSync(path.join(evidence,'accessibility-responsive.json'),JSON.stringify(results,null,2));expect(results.flatMap(r=>r.violations)).toEqual([]);
});
