import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=dirname(fileURLToPath(import.meta.url));
const feedback=join(root,'..','taphound-flash','scripts','feedback.mjs');
const fake=join(root,'fixtures','fake-field-runner.mjs');
async function context(fn){const dir=await mkdtemp(join(tmpdir(),'taphound-feedback-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
function invoke(dir,args,env={}){
  const r=spawnSync(process.execPath,[feedback,...args],{cwd:dir,env:{...process.env,...env},encoding:'utf8',timeout:15000});
  assert.equal(r.signal,null,r.stderr||r.stdout); let response;try{response=JSON.parse(r.stdout);}catch{throw new Error('Invalid JSON: '+r.stdout+'\n'+r.stderr)}
  return {...response,exit:r.status};
}
function read(dir,rel){return readFile(join(dir,rel),'utf8');}
async function prep(dir,skill='tap-check'){
  const home=join(dir,'feedback');const plan=join(dir,'plan.json');await writeFile(plan,'{"version":1,"packageName":"dev.example.app","steps":[{"action":"expect","target":{"text":"Done"}}]}\n');
  assert.equal(invoke(dir,['start','--dir',home,'--skill',skill,'--task','Verify form submit']).exit,0);
  const impact=join(dir,'impact-plan.json');
  await writeFile(impact,JSON.stringify({version:1,changeIntent:'Verify form submit',target:{id:'form-submit',expected:'Done element visible'},scenarios:[],existingTests:[],risks:[]}));
  assert.equal(invoke(dir,['impact','--dir',home,'--file',impact]).exit,0);
  const reviewPath=join(dir,'oracle-review.json');await writeFile(reviewPath,JSON.stringify({version:1,expectations:[{id:'new-behavior',scope:'target',when:'Submit form',then:'Done is visible',confidence:'supported',sources:[{kind:'requirement',ref:'user task: form submit'}]}],uncertainties:[]}));
  assert.equal(invoke(dir,['oracle','--dir',home,'--file',reviewPath]).exit,0);
  await mkdir(join(dir,'src/main'),{recursive:true});await writeFile(join(dir,'src/main/UnrelatedFeature.kt'),'class UnrelatedFeature {}');
  assert.equal(invoke(dir,['discover','--dir',home,'--project',dir,'--source','src/main/UnrelatedFeature.kt']).exit,0);
  for(const gate of ['existing-tests','regression'])assert.equal(invoke(dir,['gate','--dir',home,'--gate',gate,'--status','NOT_APPLICABLE','--summary','No affected related tests/scenarios discovered in this synthetic fixture','--evidence',gate==='existing-tests'?'tests/discovery.json':'impact/plan.json']).exit,0);
  return {home,plan,impact};
}
function targetGate(dir,home,id, evidence='') {
  const file=evidence||`attempts/${id}/attempt.json`;
  return invoke(dir,['gate','--dir',home,'--gate','target','--status','PASS','--attempt',id,'--evidence',file,'--summary','Target behavior verified']);
}
test('Skill A: failed attempt survives automatic self-repair and final PASS, ZIP is generated',async()=>context(async dir=>{
  const {home,plan}=await prep(dir);
  let r=invoke(dir,['run','--dir',home,'--plan',plan,'--runner',fake],{TAPHOUND_TEST_STATUS:'failed'});
  assert.equal(r.exit,1);assert.equal(r.attempt,'001');
  r=invoke(dir,['event','--dir',home,'--type','diagnosis','--summary','Wrong expected UI state']);assert.equal(r.exit,0);
  r=invoke(dir,['event','--dir',home,'--type','code-change','--summary','Fixed app state transition']);assert.equal(r.exit,0);
  r=invoke(dir,['run','--dir',home,'--plan',plan,'--runner',fake],{TAPHOUND_TEST_STATUS:'passed'});
  assert.equal(r.exit,0);assert.equal(r.attempt,'002');
  assert.equal(targetGate(dir,home,'002').exit,0);
  r=invoke(dir,['finish','--dir',home,'--status','PASS','--summary','UI and logs verified']);assert.equal(r.exit,0);
  assert.match(await read(home,'summary.md'),/Intermediate failures: \*\*1\*\*/);
  assert.match(await read(home,'summary.md'),/Fixed app state transition/);
  assert.match(await read(home,'attempts/001/attempt.json'),/APP_CRASHED/);
  assert.match(await read(home,'attempts/002/attempt.json'),/"status": "passed"/);
  const zip=await readFile(join(home,'feedback.zip'));assert.equal(zip.readUInt32LE(0),0x04034b50);
  assert.ok(zip.includes(Buffer.from('attempts/001/attempt.json')));
  assert.ok(zip.includes(Buffer.from('attempts/002/attempt.json')));
}));
test('Skill B: FIXED verdict refuses unconfirmed RED or different plan; accepts frozen RED -> GREEN',async()=>context(async dir=>{
  const {home,plan}=await prep(dir,'tap-fix');
  let r=invoke(dir,['run','--dir',home,'--plan',plan,'--runner',fake],{TAPHOUND_TEST_STATUS:'failed'});
  assert.equal(r.exit,1);
  r=invoke(dir,['run','--dir',home,'--plan',plan,'--runner',fake],{TAPHOUND_TEST_STATUS:'passed'});
  assert.equal(r.exit,0);
  assert.equal(invoke(dir,['finish','--dir',home,'--status','FIXED','--summary','Crash resolved']).code,'GATE_INCOMPLETE');
  assert.equal(invoke(dir,['event','--dir',home,'--type','reproduction-confirmed','--summary','Crash signature matches original report','--attempt','001','--evidence','attempts/001/evidence/field-result.json']).exit,0);
  assert.equal(targetGate(dir,home,'002').exit,0);
  r=invoke(dir,['finish','--dir',home,'--status','FIXED','--summary','Same frozen scenario now passes']);assert.equal(r.exit,0);
  assert.match(await read(home,'summary.md'),/Final verdict: \*\*FIXED\*\*/);
}));
test('cannot claim PASS on a missing-log INCONCLUSIVE; allow retaining summary',async()=>context(async dir=>{
  const {home,plan}=await prep(dir);
  assert.equal(invoke(dir,['run','--dir',home,'--plan',plan,'--runner',fake],{TAPHOUND_TEST_STATUS:'inconclusive'}).exit,4);
  assert.equal(invoke(dir,['finish','--dir',home,'--status','PASS','--summary','It worked']).code,'GATE_INCOMPLETE');
  assert.equal(invoke(dir,['finish','--dir',home,'--status','INCONCLUSIVE','--summary','Log evidence absent']).exit,0);
  assert.match(await read(home,'summary.md'),/Log evidence absent/);
}));
test('exec records failed and passing unit tests; attach preserves additional evidence',async()=>context(async dir=>{
  const {home}=await prep(dir,'tap-fix');
  let r=invoke(dir,['exec','--dir',home,'--label','unit-test','--',process.execPath,'-e','process.exit(1)']);assert.equal(r.exit,1);
  r=invoke(dir,['exec','--dir',home,'--label','unit-test','--',process.execPath,'-e','process.exit(0)']);assert.equal(r.exit,0);
  const file=join(dir,'debug.txt');await writeFile(file,'debug evidence');r=invoke(dir,['attach','--dir',home,'--file',file]);assert.equal(r.exit,0);
  assert.equal((await readdir(join(home,'attachments'))).length,1);
  assert.equal((await readdir(join(home,'attempts'))).length,2);
  assert.ok((await read(home,'timeline.jsonl')).includes('attachment'));
}));
test('FIXED refuses a changed plan and keeps the original immutable plan snapshot',async()=>context(async dir=>{
  const {home,plan}=await prep(dir,'tap-fix');
  assert.equal(invoke(dir,['run','--dir',home,'--plan',plan,'--runner',fake],{TAPHOUND_TEST_STATUS:'failed'}).exit,1);
  const original=await read(home,'attempts/001/plan.snapshot.json');
  assert.equal(invoke(dir,['event','--dir',home,'--type','reproduction-confirmed','--summary','Matched reported crash','--attempt','001','--evidence','attempts/001/evidence/field-result.json']).exit,0);
  await writeFile(plan,original.replace('Done','Success'));
  assert.equal(invoke(dir,['run','--dir',home,'--plan',plan,'--runner',fake],{TAPHOUND_TEST_STATUS:'passed'}).exit,0);
  assert.equal(targetGate(dir,home,'002').exit,0);
  assert.equal(invoke(dir,['finish','--dir',home,'--status','FIXED','--summary','Different test oracle']).code,'VERDICT_UNSUPPORTED');
  assert.equal(await read(home,'attempts/001/plan.snapshot.json'),original);
  assert.notEqual(await read(home,'attempts/002/plan.snapshot.json'),original);
}));
test('Git workspace edits between test attempts automatically leave a timeline marker',async()=>context(async dir=>{
  const git=(...args)=>spawnSync('git',args,{cwd:dir,encoding:'utf8'});
  assert.equal(git('init','-q').status,0);
  await writeFile(join(dir,'a.txt'),'one\n');
  assert.equal(git('add','a.txt').status,0);
  assert.equal(git('-c','user.name=Test','-c','user.email=t@example.invalid','commit','-qm','initial').status,0);
  const {home,plan}=await prep(dir);
  assert.equal(invoke(dir,['run','--dir',home,'--plan',plan,'--runner',fake],{TAPHOUND_TEST_STATUS:'failed'}).exit,1);
  await writeFile(join(dir,'a.txt'),'two\n');
  assert.equal(invoke(dir,['run','--dir',home,'--plan',plan,'--runner',fake],{TAPHOUND_TEST_STATUS:'passed'}).exit,0);
  assert.match(await read(home,'timeline.jsonl'),/workspace-changed-between-attempts/);
}));

test('script contents are snapshotted and changed test script cannot establish FIXED even with identical command',async()=>context(async dir=>{
  const {home}=await prep(dir,'tap-fix');
  const script=join(dir,'verify_repro.sh');
  await writeFile(script,'#!/usr/bin/env bash\necho "BUG_REPRODUCED: overlap"\nexit 1\n');
  const cmd=['exec','--dir',home,'--label','red','--','env','SERIAL=FAKE','bash',script];
  let r=invoke(dir,cmd);assert.equal(r.exit,1);
  const original=await read(home,'attempts/001/oracles/001-verify_repro.sh');
  assert.match(original,/BUG_REPRODUCED/);
  assert.equal(invoke(dir,['event','--dir',home,'--type','reproduction-confirmed','--attempt','001','--evidence','attempts/001/stdout.txt','--summary','Observed overlap bounds']).exit,0);
  await writeFile(script,'#!/usr/bin/env bash\necho "PASS: banner hidden"\nexit 0\n');
  r=invoke(dir,['exec','--dir',home,'--label','green','--','env','SERIAL=FAKE','bash',script]);assert.equal(r.exit,0);
  const red=JSON.parse(await read(home,'attempts/001/attempt.json'));
  const green=JSON.parse(await read(home,'attempts/002/attempt.json'));
  assert.equal(red.commandSha256,green.commandSha256);
  assert.notEqual(red.oracleSha256,green.oracleSha256);
  assert.notEqual(original,await read(home,'attempts/002/oracles/001-verify_repro.sh'));
  assert.equal(targetGate(dir,home,'002').exit,0);
  assert.equal(invoke(dir,['finish','--dir',home,'--status','FIXED','--summary','Should refuse test changes']).code,'VERDICT_UNSUPPORTED');
}));

test('matching frozen shell script and trace-backed reproduction can finish FIXED',async()=>context(async dir=>{
  const {home}=await prep(dir,'tap-fix');
  const script=join(dir,'verify_repro.sh');
  // The script only changes the tested condition via the environment; oracle stays frozen.
  await writeFile(script,'#!/usr/bin/env bash\nif [ "$FIXED" = "1" ]; then echo "PASS"; exit 0; else echo "ERROR actual=overlap"; exit 1; fi\n');
  const args=['exec','--dir',home,'--label','repro','--','bash',script];
  assert.equal(invoke(dir,args,{FIXED:'0'}).exit,1);
  assert.equal(invoke(dir,['event','--dir',home,'--type','reproduction-confirmed','--attempt','001','--evidence','attempts/001/stdout.txt','--summary','Confirmed overlap in RED']).exit,0);
  assert.equal(invoke(dir,args,{FIXED:'1'}).exit,0);
  assert.equal(targetGate(dir,home,'002').exit,0);
  assert.equal(invoke(dir,['finish','--dir',home,'--status','FIXED','--summary','Same test now green']).exit,0);
  const identity=JSON.parse(await read(home,'attempts/002/apk-identity.json'));
  assert.equal(identity.agreement,'unverified');
}));

test('launch errors cannot be declared a reproduction',async()=>context(async dir=>{
  const {home}=await prep(dir,'tap-fix');
  assert.equal(invoke(dir,['exec','--dir',home,'--','file-that-does-not-exist-abcdef']).exit,1);
  assert.equal(invoke(dir,['event','--dir',home,'--type','reproduction-confirmed','--attempt','001','--evidence','attempts/001/stdout.txt','--summary','Incorrect claim']).code,'INVALID_REPRO');
  const row=JSON.parse(await read(home,'attempts/001/attempt.json'));
  assert.equal(row.classification,'INFRA_ERROR');
}));

test('extra oracle file tracks test source when invoking a wrapper command',async()=>context(async dir=>{
  const {home}=await prep(dir,'tap-fix');
  const testFile=join(dir,'app','src','test','ImportantCase.kt');await mkdir(dirname(testFile),{recursive:true});await writeFile(testFile,'assertEquals(1, actual)');
  const cmd=['exec','--dir',home,'--oracle-file',testFile,'--',process.execPath,'-e','process.exit(0)'];
  assert.equal(invoke(dir,cmd).exit,0);
  const doc=JSON.parse(await read(home,'attempts/001/oracle-manifest.json'));
  assert.equal(doc.files.length,1);assert.equal(doc.files[0].available,true);
  assert.equal(await read(home,'attempts/001/'+doc.files[0].snapshot),'assertEquals(1, actual)');
}));

test('run uses frozen copied plan, not a plan that may be rewritten while executing',async()=>context(async dir=>{
  const {home,plan}=await prep(dir,'tap-check');
  assert.equal(invoke(dir,['run','--dir',home,'--plan',plan,'--runner',fake]).exit,0);
  const row=JSON.parse(await read(home,'attempts/001/attempt.json'));
  assert.equal(row.command[3],join(home,'attempts','001','plan.snapshot.json'));
}));

test('exec device sidecar preserves before/after screenshot hierarchy Logcat and APK identity',async()=>context(async dir=>{
  const {home}=await prep(dir,'tap-fix');
  const apk=join(dir,'app-debug.apk');await writeFile(apk,'FAKE APK BYTES');
  const {createHash}=await import('node:crypto');const checksum=createHash('sha256').update('FAKE APK BYTES').digest('hex');
  const fakeAdb=join(root,'fixtures','fake-feedback-adb.mjs');
  const script=join(dir,'verify.sh');await writeFile(script,'#!/usr/bin/env bash\necho "PASS: expected UI state"\n');
  const r=invoke(dir,['exec','--dir',home,'--device','FAKE123','--package','dev.example.app','--apk',apk,'--backend','adb','--','bash',script],{ADB:fakeAdb,FAKE_INSTALLED_SHA:checksum});
  assert.equal(r.exit,0);
  const capture=JSON.parse(await read(home,'attempts/001/evidence/capture-manifest.json'));
  assert.equal(capture.before.status,'complete');assert.equal(capture.after.status,'complete');
  assert.equal(capture.logcat.status,'captured');
  assert.match(await read(home,'attempts/001/evidence/logcat.txt'),/Wrapped\/Log/);
  const device=JSON.parse(await read(home,'attempts/001/apk-identity.json'));
  assert.equal(device.agreement,'matched');assert.equal(device.installed.versionCode,'42');
  const attempt=JSON.parse(await read(home,'attempts/001/attempt.json'));
  assert.equal(attempt.deviceEvidence,'complete');assert.equal(attempt.apkAgreement,'matched');
}));

test('FIXED refuses a mismatching device APK even when red and green scripts agree',async()=>context(async dir=>{
  const {home}=await prep(dir,'tap-fix');
  const fakeAdb=join(root,'fixtures','fake-feedback-adb.mjs');
  const apk=join(dir,'app-debug.apk');await writeFile(apk,'FAKE APK BYTES');
  const script=join(dir,'verify.sh');await writeFile(script,'#!/usr/bin/env bash\nif [ "$FIXED" = "1" ]; then echo "PASS"; else echo "BUG observed"; exit 1; fi\n');
  const cmd=['exec','--dir',home,'--device','FAKE123','--package','dev.example.app','--apk',apk,'--','bash',script];
  assert.equal(invoke(dir,cmd,{ADB:fakeAdb,FIXED:'0'}).exit,1);
  assert.equal(invoke(dir,['event','--dir',home,'--type','reproduction-confirmed','--summary','Observed old behavior','--attempt','001','--evidence','attempts/001/stdout.txt']).exit,0);
  assert.equal(invoke(dir,cmd,{ADB:fakeAdb,FIXED:'1'}).exit,0);
  const attempt=JSON.parse(await read(home,'attempts/002/attempt.json'));assert.equal(attempt.apkAgreement,'mismatched');
  assert.equal(targetGate(dir,home,'002').code,'GATE_ATTEMPT_FAILED');
  assert.equal(invoke(dir,['finish','--dir',home,'--status','FIXED','--summary','Must refuse APK mismatch']).code,'GATE_INCOMPLETE');
}));

test('test-oracle mutation during one attempt is recorded and cannot be used to claim FIXED',async()=>context(async dir=>{
  const {home}=await prep(dir,'tap-fix');
  const script=join(dir,'oracle.sh');
  await writeFile(script,'#!/bin/bash\nif [ "$FIXED" = "1" ]; then echo "PASS"; else echo "BUG"; exit 1; fi\n');
  const cmd=['exec','--dir',home,'--','bash',script];
  assert.equal(invoke(dir,cmd,{FIXED:'0'}).exit,1);
  assert.equal(invoke(dir,['event','--dir',home,'--type','reproduction-confirmed','--summary','Verified reported failure','--attempt','001','--evidence','attempts/001/stdout.txt']).exit,0);
  // Same script bytes at start, but the test rewrites itself during the GREEN run.
  await writeFile(script,'#!/bin/bash\nif [ "$FIXED" = "1" ]; then echo "PASS"; else echo "BUG"; exit 1; fi\n');
  const mutate=join(dir,'mutate.mjs');
  await writeFile(mutate,`import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(script)},'CHANGED');\n`);
  // Use a command with the same oracle file explicitly but execute a mutation via inline Node.
  const cmdMut=['exec','--dir',home,'--oracle-file',script,'--',process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(script)},'CHANGED')`];
  assert.equal(invoke(dir,cmdMut).exit,0);
  const attempt=JSON.parse(await read(home,'attempts/002/attempt.json'));
  assert.equal(attempt.oracleChangedDuringRun,true);
}));

test('Gradle wrapper alone is insufficient; FIXED needs the test source as explicit oracle',async()=>context(async dir=>{
  const {home}=await prep(dir,'tap-fix');
  const gradlew=join(dir,'gradlew');
  await writeFile(gradlew,'#!/bin/bash\n[ "$FIXED" = "1" ] && exit 0 || exit 1\n');
  const cmd=['exec','--dir',home,'--','bash',gradlew,'test'];
  assert.equal(invoke(dir,cmd,{FIXED:'0'}).exit,1);
  assert.equal(invoke(dir,['event','--dir',home,'--type','reproduction-confirmed','--summary','Unit test failed for reported behavior','--attempt','001','--evidence','attempts/001/attempt.json']).exit,0);
  assert.equal(invoke(dir,cmd,{FIXED:'1'}).exit,0);
  assert.equal(targetGate(dir,home,'002').exit,0);
  assert.equal(invoke(dir,['finish','--dir',home,'--status','FIXED','--summary','No actual test code snapshot']).code,'VERDICT_UNSUPPORTED');
}));

test('oracle changes after successful target gate invalidate old PASS even if device command stays green',async()=>context(async dir=>{
  const {home,plan}=await prep(dir);
  assert.equal(invoke(dir,['run','--dir',home,'--plan',plan,'--runner',fake],{TAPHOUND_TEST_STATUS:'passed'}).exit,0);
  assert.equal(targetGate(dir,home,'001').exit,0);
  const next=join(dir,'new-review.json');
  await writeFile(next,JSON.stringify({version:1,expectations:[{id:'new-behavior',scope:'target',when:'Submit form',then:'Different result',confidence:'supported',sources:[{kind:'requirement',ref:'updated task note'}]}],uncertainties:[]}));
  assert.equal(invoke(dir,['oracle','--dir',home,'--file',next]).exit,0);
  assert.equal(invoke(dir,['finish','--dir',home,'--status','PASS','--summary','Old gate']).code,'STALE_ORACLE');
}));


test('uncertain target requirement prevents a false PASS Gate without prompting the user',async()=>context(async dir=>{
  const {home,plan}=await prep(dir);
  const reviewed=join(dir,'uncertain-oracle.json');
  await writeFile(reviewed,JSON.stringify({version:1,expectations:[{id:'new-behavior',scope:'target',when:'Submit form',then:'Unclear result',confidence:'uncertain',sources:[{kind:'requirement',ref:'ambiguous task wording'}]}],uncertainties:[{id:'missing-product-rule',reason:'Cannot tell whether form auto-submits',blocking:true}]}));
  assert.equal(invoke(dir,['oracle','--dir',home,'--file',reviewed]).exit,0);
  assert.equal(invoke(dir,['run','--dir',home,'--plan',plan,'--runner',fake],{TAPHOUND_TEST_STATUS:'passed'}).exit,0);
  const g=targetGate(dir,home,'001');assert.equal(g.code,'ORACLE_UNRESOLVED');
  assert.equal(invoke(dir,['finish','--dir',home,'--status','INCONCLUSIVE','--summary','Continue independent tests, product behavior unclear']).exit,0);
}));
