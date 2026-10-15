const {chromium,expect}=require('@playwright/test');
const readline=require('node:readline');
const fs=require('node:fs');
const path=require('node:path');
if(process.stdin.isTTY)process.stdin.setRawMode(true);
const input=readline.createInterface({input:process.stdin,terminal:false});
console.log('Ready for private-site verification credential on stdin.');
input.once('line',async line=>{
  input.close();if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdin.pause();let browser;
  try{
    const {url,token}=JSON.parse(line);browser=await chromium.launch();
    const context=await browser.newContext({viewport:{width:1440,height:900},extraHTTPHeaders:token?{'OAI-Sites-Authorization':'Bearer '+token}:{}});
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const response=await page.goto(url);await expect(page).toHaveTitle(/R7 작업 공간/);console.log('Hosted R7 document loaded.');
    await page.waitForTimeout(1000);
    console.log(JSON.stringify(await page.evaluate(()=>({errors:window.workbenchDemo?null:'workspace script not ready',frames:[...document.querySelectorAll('iframe')].map(e=>{let ready;try{ready=!!e.contentWindow.paneAPI;}catch{ready='cross-origin';}return {className:e.className,id:e.dataset.sessionFrame,ready};})}))));
    if(errors.length)console.log(JSON.stringify({errors}));
    await page.waitForFunction(()=>[...document.querySelectorAll('.wb-frame')].length===3&&[...document.querySelectorAll('.wb-frame')].every(e=>e.contentWindow.paneAPI));
    await page.locator('[data-layout="triple"]').click();await expect(page.locator('.wb-group')).toHaveCount(3);
    await page.waitForFunction(()=>[...document.querySelectorAll('.wb-frame')].every(e=>e.contentWindow.paneAPI));
    await page.screenshot({path:path.join(__dirname,'evidence','hosted-desktop-triple.png')});
    const next=page.waitForEvent('popup');await page.locator('[data-action="detach"]').click();const popup=await next;await popup.waitForFunction(()=>!!document.querySelector('iframe')?.contentWindow.paneAPI);
    await popup.locator('[data-layout="columns"]').click();await expect(popup.locator('.wb-group')).toHaveCount(2);await popup.waitForFunction(()=>[...document.querySelectorAll('.wb-frame')].every(e=>e.contentWindow.paneAPI));await popup.locator('[data-action="return-all"]').click();
    await expect(page.locator('iframe[data-session-frame="main"]')).toBeVisible();
    const result={url,status:response.status(),title:await page.title(),threePaneLayout:true,realPopupSplitAndReturn:true,errors};
    fs.writeFileSync(path.join(__dirname,'evidence','hosted-smoke.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }catch(error){console.error(error.message);process.exitCode=1;}finally{await browser?.close();}
});
