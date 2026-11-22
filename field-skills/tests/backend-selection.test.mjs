import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url));
const runner=join(here,'..','taphound-flash','scripts','field-runner.mjs');
async function temp(fn){const d=await mkdtemp(join(tmpdir(),'tap-mcp-'));try{await fn(d)}finally{await rm(d,{recursive:true,force:true})}}
async function fakeMcp(dir,devices=['FAKE123'],appearance=false){
  const exe=join(dir,'mcp-server-mobile');
  const script=`#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nlet clicked=false;const appearance=${JSON.stringify(appearance)};let pending='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{pending+=chunk;let i;while((i=pending.indexOf('\\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);let req;try{req=JSON.parse(line)}catch{continue}if(req.id===undefined)continue;const tool=req.params?.name;let data;switch(tool){case 'mobile_list_available_devices':data=JSON.stringify({devices:${JSON.stringify(devices)}.map(id=>({id,platform:'Android',state:'online'}))});break;case 'mobile_get_screen_size':data='Screen size is 1080x1920 pixels';break;case 'mobile_list_elements_on_screen':data='Found these elements on screen: '+JSON.stringify(appearance&&!clicked?[{identifier:'open',text:'Open',coordinates:{x:100,y:100,width:100,height:60}}]:[{identifier:'result',text:'Hello',label:'Messages, 46 new notifications',coordinates:{x:100,y:100,width:100,height:60}}]);break;case 'mobile_click_on_screen_at_coordinates':clicked=true;data='ok';break;case 'mobile_save_screenshot':writeFileSync(req.params.arguments.saveTo,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WTn23wAAAAASUVORK5CYII=','base64'));data='ok';break;default:data='ok'};const result=tool?{content:[{type:'text',text:data}]}:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fake-mobile-mcp',version:'0.1'}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n')}});\n`;
  await writeFile(exe,script,{mode:0o700});await chmod(exe,0o700);return exe;
}
const plan={version:1,packageName:'dev.taphound.demo',verificationMode:'smoke',steps:[{action:'expect',target:{text:'Hello'}}]};
test('auto prioritizes an available Mobile MCP for UI, even with Appium/ADB fallback configured',()=>temp(async dir=>{
  const mcp=await fakeMcp(dir),p=join(dir,'plan.json'),out=join(dir,'out');await writeFile(p,JSON.stringify(plan));
  const result=spawnSync(process.execPath,[runner,'run',p,'--device','FAKE123','--out',out,'--backend','auto'],{env:{...process.env,TAPHOUND_MCP_COMMAND:mcp,TAPHOUND_APPIUM_URL:'http://127.0.0.1:1',ADB:'___NO_ADB___'},encoding:'utf8',timeout:17000});
  assert.equal(result.status,0,`${result.stderr} ${result.stdout}`);
  const value=JSON.parse(result.stdout);assert.equal(value.backend,'mobile-mcp');assert.equal(value.device,'FAKE123');assert.equal(value.status,'passed');
  assert.equal(value.steps[0].action,'expect');assert.equal((await readFile(join(out,'screenshot.png'))).length>0,true);
}));

test('Mobile MCP cannot silently pick another device when the explicitly selected serial is absent',()=>temp(async dir=>{
  const mcp=await fakeMcp(dir,['OTHER']),p=join(dir,'plan.json');await writeFile(p,JSON.stringify(plan));
  const result=spawnSync(process.execPath,[runner,'probe',p,'--device','FAKE123','--backend','mobile-mcp'],{env:{...process.env,TAPHOUND_MCP_COMMAND:mcp,ADB:'___NO_ADB___'},encoding:'utf8',timeout:17000});
  assert.equal(result.status,3);assert.match(result.stdout,/NO_BACKEND/);
}));

test('Mobile MCP refuses ambiguous multiple Android devices if user supplied no serial',()=>temp(async dir=>{
  const mcp=await fakeMcp(dir,['A','B']),p=join(dir,'plan.json');await writeFile(p,JSON.stringify(plan));
  const result=spawnSync(process.execPath,[runner,'probe',p,'--backend','mobile-mcp'],{env:{...process.env,TAPHOUND_MCP_COMMAND:mcp,ADB:'___NO_ADB___'},encoding:'utf8',timeout:17000});
  assert.equal(result.status,3);assert.match(result.stdout,/NO_BACKEND/);
}));

test('Mobile MCP uses the shared prefix locator for dynamic notification labels',()=>temp(async dir=>{
  const mcp=await fakeMcp(dir),p=join(dir,'prefix.json'),out=join(dir,'prefix-out');
  await writeFile(p,JSON.stringify({version:1,packageName:'dev.taphound.demo',verificationMode:'smoke',steps:[{action:'expect',target:{desc:'Messages',match:'prefix'}}]}));
  const result=spawnSync(process.execPath,[runner,'run',p,'--device','FAKE123','--out',out,'--backend','mobile-mcp'],{env:{...process.env,TAPHOUND_MCP_COMMAND:mcp,ADB:'___NO_ADB___'},encoding:'utf8',timeout:17000});
  assert.equal(result.status,0,`${result.stderr} ${result.stdout}`);
  const value=JSON.parse(result.stdout);assert.equal(value.status,'passed');assert.equal(value.backend,'mobile-mcp');
}));


test('newSinceAction fails closed when a result card already existed before the tap',()=>temp(async dir=>{
  const mcp=await fakeMcp(dir),p=join(dir,'stale.json'),out=join(dir,'stale-out');
  await writeFile(p,JSON.stringify({version:1,packageName:'dev.taphound.demo',steps:[{action:'tap',target:{text:'Hello'}},{action:'expect',target:{text:'Hello'},newSinceAction:true}]}));
  const result=spawnSync(process.execPath,[runner,'run',p,'--device','FAKE123','--out',out,'--backend','mobile-mcp'],{env:{...process.env,TAPHOUND_MCP_COMMAND:mcp,ADB:'___NO_ADB___'},encoding:'utf8',timeout:17000});
  assert.equal(result.status,1,`${result.stderr} ${result.stdout}`);
  const data=JSON.parse(result.stdout);assert.equal(data.status,'failed');assert.equal(data.failure.code,'STALE_EXPECTATION');
}));
test('newSinceAction passes when the result appears only after the tap',()=>temp(async dir=>{
  const mcp=await fakeMcp(dir,['FAKE123'],true),p=join(dir,'fresh.json'),out=join(dir,'fresh-out');
  await writeFile(p,JSON.stringify({version:1,packageName:'dev.taphound.demo',steps:[{action:'tap',target:{text:'Open'}},{action:'expect',target:{text:'Hello'},newSinceAction:true}]}));
  const result=spawnSync(process.execPath,[runner,'run',p,'--device','FAKE123','--out',out,'--backend','mobile-mcp'],{env:{...process.env,TAPHOUND_MCP_COMMAND:mcp,ADB:'___NO_ADB___'},encoding:'utf8',timeout:17000});
  assert.equal(result.status,0,`${result.stderr} ${result.stdout}`);
  const data=JSON.parse(result.stdout);assert.equal(data.status,'passed');assert.equal(data.steps[1].freshness.verifiedNotPresentBeforeAction,true);
}));
