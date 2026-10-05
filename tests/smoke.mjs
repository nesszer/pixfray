import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const browser = await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] /* WebGL on the GPU, not software, with no window */});
const base=process.env.MINI_BASE_URL||'http://127.0.0.1:5173';
const out=fileURLToPath(new URL('../screenshots', import.meta.url)); fs.mkdirSync(out,{recursive:true});
const errors=[];
try {
 const page=await browser.newPage({viewport:{width:1920,height:1080}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);
 assert.match(await page.title(),/PixFray/);
 await page.screenshot({path:out+'/setup-preview.png',fullPage:true});
 await page.goto(base+'/overlay.html?demo=1&debug=1&cap=50&size=64');
 await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('8/50'));
 await page.waitForTimeout(700);
 const pixels=await page.evaluate(()=>{const c=document.querySelector('#stage'),ctx=c.getContext('2d');const d=ctx.getImageData(0,0,c.width,c.height).data;let bottom=0;for(let i=3;i<d.length;i+=4)if(d[i])bottom++;return {top:ctx.getImageData(20,20,1,1).data[3],painted:bottom};});
 assert.equal(pixels.top,0);assert.ok(pixels.painted>1000);
 await page.screenshot({path:out+'/overlay-preview.png',omitBackground:true});
 await page.setViewportSize({width:390,height:844});
 await page.waitForTimeout(200);
 assert.equal(await page.locator('#stage').evaluate(c=>c.width),390);
 const context=await browser.newContext({viewport:{width:1920,height:1080}});
 await context.addInitScript(()=>{
  window.__sockets=[];
  class FakeWS{
   constructor(){this.readyState=1;this.sent=[];window.__sockets.push(this);setTimeout(()=>this.onopen?.(),0);}
   send(m){this.sent.push(m);}
   close(){this.readyState=3;this.onclose?.();}
  }
  window.WebSocket=FakeWS;
  window.__irc=data=>window.__sockets.at(-1).onmessage?.({data});
 });
 const mock=await context.newPage();mock.on('pageerror',e=>errors.push(e.message));
 await mock.goto(base+'/overlay.html?debug=1&cap=2');
 await mock.waitForFunction(()=>window.__sockets.length>0);
 await mock.evaluate(()=>window.__irc(':tmi.twitch.tv 366 anon #nesszerra :End of /NAMES list\r\n'));
 const message=(id,user,text)=>'@id='+id+';user-id='+user+';display-name='+user+';color=#aabbcc :'+user+'!'+user+'@'+user+'.tmi.twitch.tv PRIVMSG #nesszerra :'+text+'\r\n';
 await mock.evaluate(m=>window.__irc(m),message('a','alice','!avatar soldier'));
 await mock.waitForFunction(()=>document.querySelector('#status').textContent.includes('1/2'));
 await mock.evaluate(m=>window.__irc(m),message('b','alice','!color #ff8844'));
 const prefs=await mock.evaluate(()=>JSON.parse(localStorage.getItem('mini-chat:cosmetics:nesszerra')));
 assert.equal(prefs.alice.avatar,'soldier');assert.equal(prefs.alice.color,'#ff8844');
 await mock.evaluate(m=>window.__irc(m),message('c','bob','hello')+message('d','charlie','hello'));
 assert.match(await mock.locator('#status').textContent(),/2\/2/);
 await mock.evaluate(()=>window.__irc('@target-user-id=bob :tmi.twitch.tv CLEARCHAT #nesszerra :bob\r\n'));
 assert.match(await mock.locator('#status').textContent(),/1\/2/);
 await mock.reload();await mock.waitForFunction(()=>window.__sockets.length>0);
 assert.equal(await mock.evaluate(()=>JSON.parse(localStorage.getItem('mini-chat:cosmetics:nesszerra')).alice.avatar),'soldier');
 await mock.evaluate(m=>window.__irc(m),message('e','alice','!jump'));
 await mock.waitForFunction(()=>document.querySelector('#status').textContent.includes('1/2'));
 await mock.evaluate(()=>window.__irc(':tmi.twitch.tv CLEARCHAT #nesszerra\r\n'));
 assert.match(await mock.locator('#status').textContent(),/0\/2/);
 await mock.evaluate(()=>window.__sockets.at(-1).close());
 await mock.waitForFunction(()=>document.querySelector('#status').textContent.includes('reconnecting'));
 await mock.waitForFunction(()=>window.__sockets.length===2,{},{timeout:5000});
 await mock.close();await context.close();
 const live=await browser.newPage();
 live.on('pageerror',e=>errors.push(e.message));
 await live.goto(base+'/overlay.html?channel=nesszerra&debug=1');
 await live.waitForFunction(()=>document.querySelector('#status').textContent.includes('connected'),{},{timeout:15000});
 console.log('LIVE_BROWSER',await live.locator('#status').textContent());
 await live.close();
 assert.deepEqual(errors,[]);
 console.log('PASS: setup URL, transparent sprite rendering, resize, commands/preferences, cap, moderation, reload, reconnect, real Twitch join; no page errors.');
} finally {await browser.close();}
