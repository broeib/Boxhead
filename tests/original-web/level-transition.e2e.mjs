import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createOriginalServer } from '../../apps/original-server/service.mjs';
const args = process.argv.slice(2);
const option = (k,d) => args.includes(k) ? args[args.indexOf(k)+1] : d;
const out = option('--out', '/tmp/boxhead-level-transition-run');
const shield = option('--expect-shield','yes') === 'yes';
await mkdir(out,{recursive:false});
const server=createOriginalServer({host:'127.0.0.1',port:0,webRoot:option('--web-root','dist/original-web')});
await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN || process.env.CHROME_PATH || undefined,headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required']});
const frames=[];let pass=false,page;
try {
 page=await browser.newPage({viewport:{width:1000,height:850}});
 const info=()=>page.evaluate(()=>{try{const v=document.querySelector('#original-ruffle-player').ruffle().callExternalInterface('bhInfo');return typeof v==='string'?JSON.parse(v):v;}catch{return null;}});
 async function until(fn,label,ms=60000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await page.waitForTimeout(60);}throw new Error('Timeout '+label);}
 async function click(name){const b=(await until(async()=> (await info())?.menuBounds?.[name],name));const s=await page.locator('#stage').boundingBox();await page.mouse.click(s.x+(b.x+b.width/2)*s.width/640,s.y+(b.y+b.height/2)*s.height/480);}
 await page.goto(process.env.BOXHEAD_TEST_ORIGIN || `http://127.0.0.1:${server.address().port}`);
 await until(async()=> (await info())?.menuReady && (await info())?.menuBounds?.online,'main',90000);
 const initialBox=await page.locator('#stage').boundingBox();
 await page.mouse.move(initialBox.x+initialBox.width/2,initialBox.y+initialBox.height/2);
 const warning=page.locator('#original-ruffle-player #hardware-acceleration-modal');
 if(await warning.isVisible())await warning.locator('.close-modal').click();
 await page.mouse.move(4,4);
 await click('online');await until(async()=> (await info())?.menuState==='online','online');await click('coop');await until(async()=> (await info())?.menuBounds?.level,'map');
 await page.evaluate(()=>{
   const player=document.querySelector('#original-ruffle-player'), original=player.ruffle;
   const evidence=window.__transitionNative={tick:0,state:'menu',calls:[]};
   player.ruffle=function(...args){const api=Reflect.apply(original,this,args);return new Proxy(api,{get(target,key){const member=Reflect.get(target,key,target);if(key!=='callExternalInterface')return typeof member==='function'?member.bind(target):member;return function(name,...parameters){const raw=Reflect.apply(member,target,[name,...parameters]);let value=raw;if(typeof raw==='string'){try{value=JSON.parse(raw);}catch{}}
     if(value && typeof value==='object'){if(typeof value.tick==='number')evidence.tick=Math.max(evidence.tick,value.tick);if(typeof value.state==='string')evidence.state=value.state;}
     evidence.calls.push({name,tick:value?.tick,state:value?.state,error:value?.error});if(evidence.calls.length>30)evidence.calls.shift();return raw;};},set(target,key,value){return Reflect.set(target,key,value,target);}});};
 });
 const start=performance.now();await click('level');let sawLoading=false,stable=0;
 for(let n=0;n<450;n++){
  const s=await page.evaluate(()=>({state:document.querySelector('#status').dataset.state,preparing:document.querySelector('#stage').dataset.networkPreparation==='true',covered:!document.querySelector('#join-sync').hidden,kind:document.querySelector('#join-sync').dataset.kind}));
  const native=await page.evaluate(()=>({...window.__transitionNative}));
  const row={ms:Math.round(performance.now()-start),...s,nativeState:native?.state,tick:native?.tick};frames.push(row);
  if(s.preparing){sawLoading=true;if(shield)assert(s.covered && s.kind==='start','Host preparation must stay covered until a real running frame');}
  await page.locator('#stage-shell').screenshot({path:path.join(out,`frame-${String(n).padStart(3,'0')}.png`)});
  if(s.state==='error')throw new Error(await page.locator('#status').innerText());
  if(s.state==='online' && native?.tick>=3){stable++;if(stable>=3)break;}
  await page.waitForTimeout(100);
 }
 assert(sawLoading,'Capture missed preparation');assert(stable>=3,'Native game did not reach running frames');
 const final=frames.at(-1);assert(!final.covered,'Loading cover must leave once actual gameplay runs');
 pass=true;console.log(JSON.stringify({pass,frames:frames.length,loadingSamples:frames.filter(f=>f.preparing).length,out}));
 }finally{
 if(!pass && page){
  await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
  await writeFile(path.join(out,'failure-info.json'),JSON.stringify(await page.evaluate(()=>({native:window.__transitionNative,status:document.querySelector('#status')?.innerText})).catch(()=>null)));
 }
 await browser.close();await server.close();await writeFile(path.join(out,'report.json'),JSON.stringify({pass,shield,frames},null,2));
}
