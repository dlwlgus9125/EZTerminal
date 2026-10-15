import path from 'node:path';
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import AxeBuilder from '@axe-core/playwright';

// Reference-only visual and input checks. No Electron, PTY or AI requests.
export async function verifyTerminalSkin({context, root, report}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const assert = (ok, reason) => { if (!ok) throw new Error(reason); };
  const go = async (id, skin='terminal', theme='dark', width=id==='M04'?390:1440, height=id==='M04'?844:900, view='detail',chatScene='') => {
    await page.setViewportSize({width,height});
    // A new scene must not inherit a previous scene's toast or in-memory draft.
    await page.goto('about:blank');
    await page.goto(pathToFileURL(path.join(root,'index.html')).href+`#render/${id}?${new URLSearchParams({skin,theme,view,chatScene,interactive:'1',session:'experience',artifact:chatScene==='review'?'1':'0'})}`);
    await page.locator('#chat-draft').waitFor();
    await page.evaluate(()=>document.fonts.ready);
  };
  try {
    for (const id of ['D18','M04']) {
      await go(id,'bubble');
      const text = await page.locator('.message .bubble').allTextContents();
      await page.locator('#chat-draft').fill('작성 중인 요청 · draft');
      await page.getByRole('button',{name:'대화 스킨 전환',exact:true}).click();
      assert(await page.locator('#chat-draft').inputValue()==='작성 중인 요청 · draft',id+' draft lost');
      assert(JSON.stringify(await page.locator('.message .bubble').allTextContents())===JSON.stringify(text),id+' semantic transcript changed');
      const geometry = await page.evaluate(() => {
        const panel=document.querySelector('.console-session');
        const user=panel.querySelector('.message.user .bubble');
        const assistant=panel.querySelector('.message.assistant .bubble');
        const style=getComputedStyle(user);
        return {left:Math.abs(user.getBoundingClientRect().left-assistant.getBoundingClientRect().left),border:style.borderTopWidth,promptOutsideOutput:!panel.querySelector('.chat-scroll #chat-form')};
      });
      assert(geometry.left<2&&geometry.border==='0px'&&geometry.promptOutsideOutput,id+' CLI skin must keep the chat composer outside scrollback');
      await page.getByRole('button',{name:'대화 스킨 전환',exact:true}).click();
      assert(await page.locator('#chat-draft').inputValue()==='작성 중인 요청 · draft',id+' draft lost returning to bubble');
      await page.locator('#chat-draft').fill('');
      report.interactions.push(id+': same transcript and draft across both skins; CLI presentation retains a fixed chat composer.');
    }
    for (const [id,width,height] of [['D18',800,600],['D18',1024,720],['D18',1440,900],['M04',360,640],['M04',390,844],['M04',412,915],['D05',1440,900],['D16',1440,900]]) {
      await go(id,'terminal','dark',width,height);
      const overflow=await page.evaluate(()=>({document:document.documentElement.scrollWidth>innerWidth+1,output:(()=>{const el=document.querySelector('.chat-scroll');return el.scrollWidth>el.clientWidth+1;})()}));
      assert(!overflow.document&&!overflow.output,`${id} terminal overflow ${width}`);
      await page.locator('#chat-draft').scrollIntoViewIfNeeded();
      const visible=await page.evaluate(()=>{const input=document.querySelector('#chat-draft').getBoundingClientRect(),panel=document.querySelector('.chat-panel').getBoundingClientRect();return input.top>=panel.top-1&&input.bottom<=panel.bottom+1&&input.bottom<=innerHeight;});
      assert(visible,id+' terminal prompt inaccessible');
      report.responsive.push({screen:id,skin:'terminal',size:[width,height],overflow,promptVisible:visible});
    }
    for (const [id,theme,name] of [['D18','dark','terminal-skin'],['M04','dark','terminal-skin'],['D18','matrix','matrix'],['D18','light','terminal-light'],['D18','contrast','terminal-contrast']]) {
      await go(id,'terminal',theme);
      await page.screenshot({path:path.join(root,'screens/variants',`${id}-${name}.png`)});
      const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      const violations=result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));
      report.accessibility.push({screen:id,skin:'terminal',theme,violations});
      assert(!violations.length,`${id} terminal ${theme} accessibility: ${JSON.stringify(violations)}`);
    }
    for (const id of ['D18','M04']) {
      await go(id,'terminal','dark',id==='M04'?390:1440,id==='M04'?844:900,'wireframe');
      await page.screenshot({path:path.join(root,'screens/variants',`${id}-terminal-wireframe.png`)});
    }
    await go('M04');
    await page.locator('#chat-draft').fill('모바일 작성 중');
    await page.locator('#chat-draft').press('Enter');
    assert((await page.locator('#chat-draft').inputValue()).includes('모바일 작성 중'),'Android Enter sent the draft');
    await page.getByRole('button',{name:'예시 메시지 전송'}).click();
    assert(await page.locator('#chat-draft').inputValue()==='','Android explicit send did not clear draft');
    await go('D18');
    await page.locator('#chat-draft').fill('한글 조합 중');
    await page.locator('#chat-draft').dispatchEvent('keydown',{key:'Enter',isComposing:true,bubbles:true});
    assert(await page.locator('#chat-draft').inputValue()==='한글 조합 중','IME composition submitted');
    await page.locator('.artifact-card').first().click();
    await page.locator('#conversation-artifact').waitFor({state:'visible'});
    assert(await page.locator('#chat-draft').inputValue()==='한글 조합 중','Artifact open lost terminal draft');
    report.interactions.push('Terminal skin retains artifact opening and IME guard; Android Enter keeps draft, explicit send submits only the example.');
    await fs.mkdir(path.join(root,'screens/chat-skins'),{recursive:true});
    for(const id of ['D18','M04'])for(const scene of ['ready','compose','streaming','approval','review'])for(const skin of ['bubble','terminal']){
      await go(id,skin,'dark',id==='M04'?390:1440,id==='M04'?844:900,'detail',scene);
      const bounds=await page.evaluate(()=>{
        const input=document.querySelector('#chat-draft').getBoundingClientRect();
        return {overflow:document.documentElement.scrollWidth>innerWidth+1,inputVisible:input.top>=0&&input.bottom<=innerHeight,overlap:[...document.querySelectorAll('.chat-pending-attachment')].some(el=>el.getBoundingClientRect().bottom>input.top+1)};
      });
      assert(!bounds.overflow&&bounds.inputVisible&&!bounds.overlap,`${id} ${scene} ${skin} layout: ${JSON.stringify(bounds)}`);
      await page.screenshot({path:path.join(root,'screens/chat-skins',`${id}-${scene}-${skin}.png`)});
      const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      const violations=result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));
      report.accessibility.push({screen:id,scene,skin,violations});
      assert(!violations.length,`${id} ${scene} ${skin} accessibility: ${JSON.stringify(violations)}`);
      report.states.push({screen:id,scene,skin,passed:true});
      if(skin==='terminal'){
        await go(id,skin,'dark',id==='M04'?390:1440,id==='M04'?844:900,'wireframe',scene);
        await page.screenshot({path:path.join(root,'screens/chat-skins',`${id}-${scene}-wireframe.png`)});
      }
    }
    for(const id of ['D18','M04']){
      await go(id,'bubble','dark',id==='M04'?390:1440,id==='M04'?844:900,'detail','compose');
      const before=await page.locator('.message').evaluateAll(els=>els.map(el=>({id:el.dataset.messageId,text:[...el.querySelectorAll('.bubble')].map(b=>b.textContent)})));
      await page.locator('#chat-draft').fill('첨부와 답장 유지');
      await page.locator('#chat-draft').evaluate(el=>el.setSelectionRange(2,5));
      await page.getByRole('button',{name:'대화 스킨 전환',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#chat-draft').selectionStart===2);
      assert(await page.locator('.chat-pending-attachment').count()===1&&await page.locator('.chat-reply').count()===1,id+' attachment/reply lost');
      const after=await page.locator('.message').evaluateAll(els=>els.map(el=>({id:el.dataset.messageId,text:[...el.querySelectorAll('.bubble')].map(b=>b.textContent)})));
      assert(JSON.stringify(before)===JSON.stringify(after),id+' message identity changed');
      await page.getByRole('button',{name:'예시 메시지 전송'}).click();
      assert(await page.locator('.message .chat-attachment').count()===1&&await page.locator('.message .chat-sent-reply').count()===1,id+' send lost attachment/reply');
      await page.getByRole('button',{name:'대화 스킨 전환',exact:true}).click();
      assert(await page.locator('.message .chat-attachment').count()===1&&await page.locator('#chat-draft').inputValue()==='',id+' sent message lost across skin switch');
      report.interactions.push(id+': message IDs, draft selection, reply and attachment survive skin switching and example submission.');
    }
    await go('D18','terminal','dark',1440,900,'detail','streaming');
    await page.locator('#chat-draft').fill('다음 요청');
    await page.getByRole('button',{name:'예시 메시지 전송'}).click();
    await page.getByRole('button',{name:'대화 스킨 전환',exact:true}).click();
    assert((await page.locator('.chat-queue').innerText()).includes('다음 요청'),'Queued followup lost during skin switch');
    await page.locator('[data-chat-action="stop"]').click();
    assert((await page.locator('.chat-stream-status').innerText()).includes('중단됨'),'Stop must preserve partial response');
    await go('D18','bubble','dark',1440,900,'detail','approval');
    await page.getByRole('button',{name:'대화 스킨 전환',exact:true}).click();
    assert(await page.locator('.chat-approval-actions').count()===1,'Skin switch resolved approval');
    await page.locator('[data-chat-action="deny"]').click();
    await page.getByRole('button',{name:'대화 스킨 전환',exact:true}).click();
    assert((await page.locator('.chat-approval').innerText()).includes('거절됨'),'Approval choice lost');
    report.interactions.push('CLI and bubble share pending approval and queued followup; only explicit stop/deny changes state.');
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1000});
      await page.goto('about:blank');await page.goto(pathToFileURL(path.join(root,'index.html')).href+'#chat-skins?platform='+ (width===390?'android':'windows')+'&scene=compose');
      await page.locator('.chat-skin-figures').waitFor();
      await page.evaluate(async()=>{for(const img of document.images)await img.decode();});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Chat skin portal overflow');
      await page.screenshot({path:path.join(root,'screens/chat-skins',`portal-${width}.png`),fullPage:true});
      const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      assert(!result.violations.length,'Chat skin portal accessibility');
      report.accessibility.push({screen:'chat-skins',width,violations:[]});
    }
    assert(!errors.length,'Terminal browser errors: '+errors.join(', '));
  } finally { await page.close(); }
}
