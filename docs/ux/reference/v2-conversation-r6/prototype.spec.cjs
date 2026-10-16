const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const path = require('node:path');
const fs = require('node:fs');
const evidence = path.join(__dirname, 'evidence');
test('responsive states retain a visible composer without page overflow', async ({ browser }) => {
  const metrics=[];
  for(const [name,width,height,touch] of [['desktop',1440,900,false],['wide',1920,1080,false],['tablet',1024,768,false],['mobile',390,844,true],['small',320,640,true]]){
    const context=await browser.newContext({viewport:{width,height},hasTouch:touch,isMobile:touch});
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:4316');
    for(const state of ['completed','working','approval','error','offline','empty','loading','uncertain','conflict','stopped']){
      await page.selectOption('#scenario',state);
      await expect(page.locator('#prompt')).toBeVisible();
      const m=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyHeight:document.documentElement.scrollHeight,height:innerHeight,composer:document.querySelector('.composer-area').getBoundingClientRect().toJSON(),send:document.querySelector('#send').getBoundingClientRect().toJSON(),transcript:document.querySelector('#transcript').getBoundingClientRect().toJSON(),header:document.querySelector('.conversation-header').getBoundingClientRect().toJSON()}));
      expect(m.documentWidth,`${name}/${state} horizontal overflow`).toBeLessThanOrEqual(width);
      expect(m.send.bottom,`${name}/${state} send bottom`).toBeLessThanOrEqual(height);
      expect(m.send.right,`${name}/${state} send right`).toBeLessThanOrEqual(width);
      expect(m.transcript.height,`${name}/${state} transcript readable`).toBeGreaterThan(110);
      if(state==='approval'){
        const approval=await page.locator('[data-action="allow"]').boundingBox();
        expect(approval.y+approval.height,`${name} approval action visible`).toBeLessThanOrEqual(m.composer.top);
      }
      metrics.push({name,state,...m});
      if(['desktop','mobile'].includes(name)&&['completed','working','approval','offline','empty'].includes(state))await page.screenshot({path:path.join(evidence,`proposal-${name}-${state}.png`)});
    }
    expect(errors).toEqual([]);
    await context.close();
  }
  fs.writeFileSync(path.join(evidence,'responsive-metrics.json'),JSON.stringify(metrics,null,2));
});
test('drafts, queue edits, approval and reconnect preserve user control', async ({ page })=>{
  await page.setViewportSize({width:1440,height:900});await page.goto('/');
  await page.locator('#prompt').fill('초안 보존 확인');
  await page.locator('[data-action="reply"]').click();
  await page.locator('[data-session="mobile"]').first().click();await page.locator('#prompt').fill('모바일 대화의 초안');
  await page.locator('[data-session="main"]').click();await expect(page.locator('#prompt')).toHaveValue('초안 보존 확인');await expect(page.locator('.quote-chip')).toBeVisible();
  await page.reload();await expect(page.locator('#prompt')).toHaveValue('초안 보존 확인');await expect(page.locator('.quote-chip')).toBeVisible();
  await page.selectOption('#scenario','working');await page.locator('#send').click();await expect(page.locator('.queue-item')).toHaveCount(2);await expect(page.locator('#prompt')).toHaveValue('');
  await page.locator('[data-queue-edit="1"]').click();await expect(page.locator('#prompt')).toHaveValue('초안 보존 확인');await expect(page.locator('.quote-chip')).toBeVisible();
  await page.locator('#send').click();await page.locator('[data-queue-delete="0"]').click();await expect(page.locator('.queue-item')).toHaveCount(1);
  await page.locator('[data-queue-now="0"]').click();await expect(page.locator('#messages')).toContainText('초안 보존 확인');
  await page.selectOption('#scenario','approval');await page.locator('[data-action="allow"]').click();await expect(page.locator('.approval-receipt')).toContainText('허용');await expect(page.locator('#stop')).toBeVisible();
  await page.selectOption('#scenario','approval');await page.locator('[data-action="deny"]').click();await expect(page.locator('.approval-receipt')).toContainText('거절');
  await page.selectOption('#scenario','offline');await page.locator('#prompt').fill('오프라인 초안');await expect(page.locator('#send')).toBeDisabled();await page.locator('[data-action="reconnect"]').click();await expect(page.locator('#prompt')).toHaveValue('오프라인 초안');await expect(page.locator('.user-message')).toHaveCount(2);
});
test('keyboard completion, IME, file review and modal focus work', async({page})=>{
  await page.setViewportSize({width:1440,height:900});await page.goto('/');
  await page.locator('#prompt').fill('/');await page.locator('#prompt').press('ArrowDown');await page.locator('#prompt').press('Enter');await expect(page.locator('#prompt')).toHaveValue('/review ');await expect(page.locator('.user-message')).toHaveCount(1);
  await page.locator('#prompt').fill('한글 조합');await page.locator('#prompt').dispatchEvent('compositionstart');await page.locator('#prompt').press('Enter');await expect(page.locator('.user-message')).toHaveCount(1);await page.locator('#prompt').dispatchEvent('compositionend');
  await page.locator('#prompt').fill('한글 조합');await page.locator('#prompt').press('Shift+Enter');await expect(page.locator('#prompt')).toHaveValue('한글 조합\n');
  await page.locator('[data-line="31"]').click();await expect(page.locator('.quote-chip')).toContainText('ChatComposer.tsx:31');await expect(page.locator('#prompt')).toBeFocused();
  await page.locator('[data-action="model"]').click();await expect(page.locator('#modal')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('[data-action="model"]')).toBeFocused();
  await page.locator('[data-action="settings"]').first().click();await page.locator('[data-skin-choice="cli"]').click();await expect(page.locator('#prompt')).toHaveValue('한글 조합\n');await expect(page.locator('.quote-chip')).toContainText('ChatComposer.tsx:31');
  await page.locator('[data-action="find"]').click();await page.locator('#find-input').fill('모바일');await expect(page.locator('#messages mark').first()).toBeVisible();
});
test('mobile review and navigation return to the same draft; Enter adds a line',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});const page=await context.newPage();await page.goto('http://127.0.0.1:4316');
  await page.locator('#prompt').fill('모바일 초안');await page.locator('#prompt').press('Enter');await expect(page.locator('#prompt')).toHaveValue('모바일 초안\n');await expect(page.locator('.user-message')).toHaveCount(1);
  await page.locator('[data-action="inspector"]').click();await expect(page.locator('#inspector')).toBeVisible();await page.locator('[data-file="1"]').click();await expect(page.locator('.diff-heading')).toContainText('ConversationView.tsx');await page.screenshot({path:path.join(evidence,'proposal-mobile-review.png')});await page.locator('[data-action="close-inspector"]').click();await expect(page.locator('#prompt')).toHaveValue('모바일 초안\n');
  await page.locator('.mobile-menu').click();await expect(page.locator('.sidebar')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('.mobile-menu')).toBeFocused();await expect(page.locator('#prompt')).toHaveValue('모바일 초안\n');await context.close();
});
test('WCAG A/AA checks for desktop, mobile approval and light view',async({browser})=>{
  const results=[];
  for(const [name,width,height,state,theme,touch] of [['desktop',1440,900,'completed','dark',false],['mobile',390,844,'approval','dark',true],['light',1440,900,'completed','light',false]]){
    const context=await browser.newContext({viewport:{width,height},hasTouch:touch,isMobile:touch});const page=await context.newPage();await page.goto('http://127.0.0.1:4316');await page.evaluate(({state,theme})=>{window.chatPrototype.setState(state);window.chatPrototype.theme(theme);},{state,theme});
    const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();results.push({name,violations:result.violations});if(theme==='light')await page.screenshot({path:path.join(evidence,'proposal-desktop-light.png')});await context.close();
  }
  fs.writeFileSync(path.join(evidence,'accessibility.json'),JSON.stringify(results,null,2));expect(results.flatMap(r=>r.violations.map(v=>({name:r.name,id:v.id,nodes:v.nodes.map(n=>n.target)})))).toEqual([]);
});
