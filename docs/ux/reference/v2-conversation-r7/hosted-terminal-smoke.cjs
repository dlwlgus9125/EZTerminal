const {chromium,expect}=require('@playwright/test');
const readline=require('node:readline'),path=require('node:path'),fs=require('node:fs');
if(process.stdin.isTTY)process.stdin.setRawMode(true);
const input=readline.createInterface({input:process.stdin,terminal:false});
console.log('Ready for private-site verification credential on stdin.');
input.once('line',async line=>{
 input.close();if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdin.pause();let browser;
 try{
  const {url,token}=JSON.parse(line);browser=await chromium.launch();const context=await browser.newContext({viewport:{width:1440,height:900},extraHTTPHeaders:token?{'OAI-Sites-Authorization':'Bearer '+token}:{}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const response=await page.goto(url);await expect(page).toHaveTitle(/R7\.1 작업 공간/);
  const ready=p=>p.waitForFunction(()=>window.workbenchDemo&&[...document.querySelectorAll('.wb-frame')].every(e=>e.contentWindow.paneAPI));await ready(page);
  await page.locator('.wb-new-terminal').click();await ready(page);const id=await page.evaluate(()=>workbenchDemo.getState().active),f=page.frameLocator(`iframe[data-session-frame="${id}"]`);
  await expect(f.locator('#terminal-cwd')).toHaveText('C:\\Working\\EZTerminal');await f.locator('#terminal-input').fill('pwd');await f.locator('#terminal-input').press('Enter');await f.locator('#terminal-input').fill('창 이동 후 유지할 입력');await page.locator('[data-layout="columns"]').click();await ready(page);
  await page.screenshot({path:path.join(__dirname,'evidence','terminal','hosted-chat-terminal.png')});
  const opening=page.waitForEvent('popup');await page.locator('[data-action="detach"]').click();const popup=await opening;popup.on('pageerror',e=>errors.push(e.message));await ready(popup);await expect(popup.frameLocator(`iframe[data-session-frame="${id}"]`).locator('#terminal-input')).toHaveValue('창 이동 후 유지할 입력');await popup.locator('[data-action="return-all"]').click();await expect(f.locator('#terminal-input')).toHaveValue('창 이동 후 유지할 입력');await expect(page.locator(`iframe[data-session-frame="${id}"]`)).toBeVisible();
  const result={url,status:response.status(),title:await page.title(),newTerminal:true,projectRoot:true,mixedSplit:true,popupReturn:true,errors};fs.writeFileSync(path.join(__dirname,'evidence','terminal','hosted-smoke.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }catch(e){console.error(e.message);process.exitCode=1;}finally{await browser?.close();}
});
