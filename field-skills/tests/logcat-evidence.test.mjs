import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec=promisify(execFile);
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const runner=join(root,'taphound-flash','scripts','field-runner.mjs');
const fakeAdb=join(root,'tests','fixtures','fake-adb.mjs');
const fakeFlash=join(root,'tests','fixtures','fake-flash.mjs');
const basePlan={version:1,verificationMode:'full',packageName:'dev.taphound.demo',steps:[{action:'tap',target:{id:'save'}},{action:'expect',target:{text:'Saved'}}],logChecks:[
  {id:'request-start',fromStep:0,messageContains:'start key=Q9',sourceRef:'src/logging/Facade.kt:call',orderGroup:'save'},
  {id:'persisted',fromStep:0,messageContains:'persisted key=Q9',sourceRef:'src/storage/Repo.kt:call',orderGroup:'save'}
]};
async function run(t,variant,plan=basePlan,prepend='') {
  const dir=await mkdtemp(join(tmpdir(),'taphound-log-v3-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const log=join(dir,'device.log'); const p=join(dir,'plan.json');const out=join(dir,'run');
  await writeFile(log,prepend);await writeFile(p,JSON.stringify(plan));
  const env={...process.env,ADB:fakeAdb,TAPHOUND_FLASH_SCRIPT:fakeFlash,
    TAPHOUND_MCP_COMMAND:'___MCP_NOT_INSTALLED___',TAPHOUND_APPIUM_URL:'http://127.0.0.1:1',FAKE_LOG_FILE:log,SIM_VARIANT:variant};
  try {const r=await exec(process.execPath,[runner,'run',p,'--backend','adb','--out',out],{env,timeout:15000});return {code:0,result:JSON.parse(r.stdout),out};}
  catch(e){if(typeof e.code==='number'&&e.stdout)return {code:e.code,result:JSON.parse(e.stdout),out};throw e;}
}
test('source-derived messages match despite wrapper and custom tag prefixes',async t=>{
  const {code,result,out}=await run(t,'pass',basePlan,'10-30 13:00:00.000  4242  4242 I Wrapped/LogProxy: persisted key=Q9\n');
  assert.equal(code,0);assert.equal(result.status,'passed');assert.equal(result.logcat.status,'passed');
  assert.equal(result.logcat.checks[0].observedCount,1);
  assert.equal(result.logcat.checks[1].observedCount,1);
  assert.ok((await readFile(join(out,'logcat.txt'),'utf8')).includes('StorageFacade'));
});
test('missing actual path event is INCONCLUSIVE, not a false green',async t=>{
  const {code,result}=await run(t,'partial');
  assert.equal(code,4);assert.equal(result.status,'inconclusive');
  assert.equal(result.failure.code,'LOG_EVIDENCE_INSUFFICIENT');
});
test('out-of-order logs fail the causal chain',async t=>{
  const {code,result}=await run(t,'reverse');
  assert.equal(code,1);assert.equal(result.status,'failed');
  assert.equal(result.failure.code,'LOG_CHAIN_MISMATCH');
});
test('forbidden error event within action window fails',async t=>{
  const plan={...basePlan,logChecks:[...basePlan.logChecks,{id:'forbidden',fromStep:0,messageContains:'error invalid state key=Q9',maxCount:0,sourceRef:'src/logging/Error.kt'}]};
  const {code,result}=await run(t,'forbidden',plan);
  assert.equal(code,1);assert.equal(result.status,'failed');
});
test('full-chain mode with no log oracle cannot greenlight UI-only',async t=>{
  const {code,result}=await run(t,'pass',{...basePlan,logChecks:undefined});
  assert.equal(code,4);assert.equal(result.failure.code,'LOG_ORACLE_NOT_DEFINED');
});
test('invalid log matching regex is rejected before any device work',async t=>{
  const {code,result}=await run(t,'pass',{...basePlan,logChecks:[{id:'invalid',fromStep:0,messageRegex:'('}]});
  assert.equal(code,2);assert.equal(result.code,'PLAN_INVALID');
});
