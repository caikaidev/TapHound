import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=dirname(fileURLToPath(import.meta.url));
const feedback=join(root,'..','taphound-flash','scripts','feedback.mjs');
const fake=join(root,'fixtures','fake-field-runner.mjs');
async function sandbox(fn){const base=await mkdtemp(join(tmpdir(),'tap34-'));try{await fn(base);}finally{await rm(base,{recursive:true,force:true});}}
function call(cwd,args,env={}){const x=spawnSync(process.execPath,[feedback,...args],{cwd,encoding:'utf8',env:{...process.env,...env},timeout:20000});assert.equal(x.signal,null);return {...JSON.parse(x.stdout||'{}'),exit:x.status};}
async function fixture(base,override={}){
  const fb=join(base,'feedback');const planPath=join(base,'plan.json');
  const plan={version:1,packageName:'dev.example.app',steps:[{action:'expect',target:{text:'Done'}}]};await writeFile(planPath,JSON.stringify(plan));
  const impact={version:1,changeIntent:'Preserve other routes while fixing A',target:{id:'A',expected:'Done appears'},scenarios:[{id:'B',description:'Old route works',intent:'preserve',risk:'high',required:true},{id:'C',description:'Other call site works',intent:'preserve',risk:'medium',required:true}],existingTests:[{id:'unit1',command:'node --test test.mjs',required:true}],risks:[],...override};
  const impactFile=join(base,'impact.json');await writeFile(impactFile,JSON.stringify(impact));
  assert.equal(call(base,['start','--dir',fb,'--skill','tap-check','--task','Check changed behavior']).exit,0);
  assert.equal(call(base,['impact','--dir',fb,'--file',impactFile]).exit,0);
  const reviewPath=join(base,'oracle-review.json');await writeFile(reviewPath,JSON.stringify({version:1,expectations:[{id:'A',scope:'target',when:'View target',then:'Done is visible',confidence:'supported',sources:[{kind:'requirement',ref:'task description'}]},{id:'B',scope:'regression',when:'Run other caller',then:'Original behavior remains',confidence:'supported',sources:[{kind:'existing-test',ref:'test of other caller'}]}],uncertainties:[]}));
  assert.equal(call(base,['oracle','--dir',fb,'--file',reviewPath]).exit,0);
  if(impact.existingTests.length===0){await mkdir(join(base,'src/main'),{recursive:true});await writeFile(join(base,'src/main/NoOldTest.kt'),'class NoOldTest {}');assert.equal(call(base,['discover','--dir',fb,'--project',base,'--source','src/main/NoOldTest.kt']).exit,0);}
  return {fb,planPath,impactFile};
}
function run(base,fb,planPath,status='passed'){return call(base,['run','--dir',fb,'--plan',planPath,'--runner',fake],{TAPHOUND_TEST_STATUS:status});}
function gate(base,fb,name,other=[]){const at=other.indexOf('--attempt');const id=at>=0?other[at+1]:'001';return call(base,['gate','--dir',fb,'--gate',name,'--status','PASS','--summary',`${name} verified`,'--evidence',`attempts/${id}/attempt.json`,...other]);}
async function report(base,{tests=3,failures=0,skipped=0}={}){const f=join(base,`TEST-${tests}-${failures}-${skipped}.xml`);await writeFile(f,`<?xml version="1.0"?><testsuite tests="${tests}" failures="${failures}" errors="0" skipped="${skipped}"><testcase name="x"/></testsuite>`);return f;}

test('PASS requires three independent gates; a green last command alone is insufficient',()=>sandbox(async base=>{
  const {fb,planPath}=await fixture(base);
  assert.equal(run(base,fb,planPath).exit,0);
  assert.equal(call(base,['finish','--dir',fb,'--status','PASS','--summary','Incorrect']).code,'GATE_INCOMPLETE');
  assert.equal(gate(base,fb,'target',['--attempt','001']).exit,0);
  assert.equal(call(base,['finish','--dir',fb,'--status','PASS','--summary','Still incorrect']).code,'GATE_INCOMPLETE');
}));

test('PASS after target + old unit tests + scenarios B/C; latest attempt may be regression, not target',()=>sandbox(async base=>{
  const {fb,planPath}=await fixture(base);
  assert.equal(run(base,fb,planPath).exit,0);assert.equal(gate(base,fb,'target',['--attempt','001']).exit,0);
  const unit=call(base,['exec','--dir',fb,'--',process.execPath,'-e','process.stdout.write("# tests 3\\n# pass 3\\n# fail 0\\n")']);assert.equal(unit.exit,0);
  const xml=await report(base);
  assert.equal(gate(base,fb,'existing-tests',['--attempt','002','--test','unit1','--test-report',xml]).exit,0);
  const newPlan=JSON.parse(await readFile(planPath,'utf8'));newPlan.scenarioIds=['B','C'];newPlan.steps=[{action:'expect',target:{text:'B expected'}},{action:'expect',target:{text:'C expected'}}];newPlan.scenarioChecks=[{id:'B',assertionSteps:[0]},{id:'C',assertionSteps:[1]}];await writeFile(planPath,JSON.stringify(newPlan));
  assert.equal(run(base,fb,planPath).exit,0);
  assert.equal(gate(base,fb,'regression',['--attempt','003','--scenario','B','--scenario','C']).exit,0);
  const fin=call(base,['finish','--dir',fb,'--status','PASS','--summary','Target and required regressions verified']);assert.equal(fin.exit,0,JSON.stringify(fin));
  const summary=await readFile(join(fb,'summary.md'),'utf8');assert.match(summary,/existing-tests: \*\*PASS\*\*/);assert.match(summary,/regression: \*\*PASS\*\*/);
  const zip=await readFile(join(fb,'feedback.zip'));assert.ok(zip.includes(Buffer.from('tests/reports/')));assert.ok(zip.includes(Buffer.from('impact/versions/')));
}));

test('existing test report with failures, no tests or all skipped cannot be called passed',()=>sandbox(async base=>{
  const {fb}=await fixture(base);
  assert.equal(call(base,['exec','--dir',fb,'--',process.execPath,'-e','']).exit,0);
  for(const opts of [{tests:3,failures:1},{tests:0,failures:0},{tests:2,failures:0,skipped:2}]){
    const xml=await report(base,opts);
    assert.equal(gate(base,fb,'existing-tests',['--attempt','001','--test','unit1','--test-report',xml]).code,'TEST_REPORT_EMPTY');
  }
}));

test('required regression scenario C cannot be silently skipped',()=>sandbox(async base=>{
  const {fb,planPath}=await fixture(base);
  run(base,fb,planPath);
  assert.equal(gate(base,fb,'regression',['--attempt','001','--scenario','B']).code,'GATE_COVERAGE_MISSING');
}));

test('blocking unverified impact risk prevents PASS even when all gates were marked green',()=>sandbox(async base=>{
  const {fb,planPath}=await fixture(base,{risks:[{id:'no-test-data',severity:'high',reason:'Cannot test active enterprise session',blocking:true}],existingTests:[],scenarios:[]});
  assert.equal(run(base,fb,planPath).exit,0);assert.equal(gate(base,fb,'target',['--attempt','001']).exit,0);
  for(const name of ['existing-tests','regression'])assert.equal(call(base,['gate','--dir',fb,'--gate',name,'--status','NOT_APPLICABLE','--summary','Analyzed and none applicable','--evidence',name==='existing-tests'?'tests/discovery.json':'impact/plan.json']).exit,0);
  assert.equal(call(base,['finish','--dir',fb,'--status','PASS','--summary','Must refuse']).code,'BLOCKING_RISK');
}));

test('tracked source changes after a green target require rerunning the gate',()=>sandbox(async base=>{
  const git=(...args)=>spawnSync('git',args,{cwd:base,encoding:'utf8'});
  assert.equal(git('init','-q').status,0);await writeFile(join(base,'app.kt'),'class App\n');assert.equal(git('add','app.kt').status,0);
  assert.equal(git('-c','user.email=test@example.com','-c','user.name=Test','commit','-qm','baseline').status,0);
  const {fb,planPath}=await fixture(base,{existingTests:[],scenarios:[]});
  assert.equal(run(base,fb,planPath).exit,0);
  assert.equal(gate(base,fb,'target',['--attempt','001']).exit,0);
  for(const name of ['existing-tests','regression'])assert.equal(call(base,['gate','--dir',fb,'--gate',name,'--status','NOT_APPLICABLE','--summary','none','--evidence',name==='existing-tests'?'tests/discovery.json':'impact/plan.json']).exit,0);
  await writeFile(join(base,'app.kt'),'class App { fun newThing() = 1 }\n');
  assert.equal(call(base,['finish','--dir',fb,'--status','PASS','--summary','Old gate']).code,'STALE_GATE');
}));

test('impact plan updates invalidate previous successful gates',()=>sandbox(async base=>{
  const {fb,planPath,impactFile}=await fixture(base,{existingTests:[],scenarios:[]});
  run(base,fb,planPath);
  gate(base,fb,'target',['--attempt','001']);
  for(const name of ['existing-tests','regression'])call(base,['gate','--dir',fb,'--gate',name,'--status','NOT_APPLICABLE','--summary','none','--evidence',name==='existing-tests'?'tests/discovery.json':'impact/plan.json']);
  const updated=JSON.parse(await readFile(impactFile,'utf8'));updated.changeIntent='New shared state impact';await writeFile(impactFile,JSON.stringify(updated));
  assert.equal(call(base,['impact','--dir',fb,'--file',impactFile]).exit,0);
  const reviewPath=join(base,'oracle-review.json');await writeFile(reviewPath,JSON.stringify({version:1,expectations:[{id:'A',scope:'target',when:'View target',then:'Done is visible',confidence:'supported',sources:[{kind:'requirement',ref:'task description'}]},{id:'B',scope:'regression',when:'Run other caller',then:'Original behavior remains',confidence:'supported',sources:[{kind:'existing-test',ref:'test of other caller'}]}],uncertainties:[]}));
  assert.equal(call(base,['oracle','--dir',fb,'--file',reviewPath]).exit,0);
  assert.equal(call(base,['finish','--dir',fb,'--status','PASS','--summary','Old gates']).code,'STALE_GATE');
}));

test('device binding rejects different serial before executing, and forbids unscoped instrumentation',()=>sandbox(async base=>{
  const fb=join(base,'fb');assert.equal(call(base,['start','--dir',fb,'--skill','tap-fix','--task','Crash','--device','FAKE123']).exit,0);
  assert.equal(call(base,['exec','--dir',fb,'--device','OTHER','--',process.execPath,'-e','process.exit(0)']).code,'DEVICE_CONFLICT');
  assert.equal(call(base,['exec','--dir',fb,'--','adb','-s','OTHER','shell','input','tap','1','2']).code,'DEVICE_CONFLICT');
  assert.equal(call(base,['exec','--dir',fb,'--','./gradlew',':app:connectedDebugAndroidTest']).code,'UNSCOPED_INSTRUMENTATION');
  assert.equal((await readFile(join(fb,'timeline.jsonl'),'utf8')).includes('attempt-started'),false);
}));

test('device PATH guard refuses an untrusted script targeting a different serial',()=>sandbox(async base=>{
  const fb=join(base,'fb'),script=join(base,'wrong.sh'),fakeAdb=join(root,'fixtures','fake-feedback-adb.mjs');
  await writeFile(script,'#!/bin/sh\nadb -s OTHER shell input tap 20 20\n');
  assert.equal(call(base,['start','--dir',fb,'--skill','tap-fix','--task','Device guard','--device','FAKE123']).exit,0);
  const result=call(base,['exec','--dir',fb,'--package','dev.example.app','--','bash',script],{ADB:fakeAdb});
  assert.equal(result.exit,1);
  const output=await readFile(join(fb,'attempts','001','stderr.txt'),'utf8');assert.match(output,/different device/);
  const attempt=JSON.parse(await readFile(join(fb,'attempts','001','attempt.json'),'utf8'));
  assert.equal(attempt.device,'FAKE123');assert.equal(attempt.deviceIsolation,'path-guarded-not-sandboxed');
}));

test('Node TAP parser can evidence existing unit tests instead of assuming build success',()=>sandbox(async base=>{
  const {fb}=await fixture(base);
  const log=join(base,'unit.tap');await writeFile(log,'TAP version 13\n1..2\n# tests 2\n# pass 2\n# fail 0\n# skipped 0\n');
  assert.equal(call(base,['exec','--dir',fb,'--',process.execPath,'-e','']).exit,0);
  const result=gate(base,fb,'existing-tests',['--attempt','001','--test','unit1','--test-report',log]);
  assert.equal(result.exit,0,JSON.stringify(result));
}));

test('a regression plan that only declares scenario IDs with no assertion mapping cannot get a green Gate',()=>sandbox(async base=>{
  const {fb,planPath}=await fixture(base,{existingTests:[],scenarios:[{id:'B',description:'Old behavior still works',intent:'preserve',risk:'high',required:true}]});
  assert.equal(run(base,fb,planPath).exit,0);assert.equal(gate(base,fb,'target',['--attempt','001']).exit,0);
  const p=JSON.parse(await readFile(planPath,'utf8'));p.scenarioIds=['B'];await writeFile(planPath,JSON.stringify(p));
  assert.equal(run(base,fb,planPath).exit,0);
  assert.equal(gate(base,fb,'regression',['--attempt','002','--scenario','B']).code,'GATE_SCENARIO_EVIDENCE');
  const timeline=await readFile(join(fb,'timeline.jsonl'),'utf8');assert.match(timeline,/GATE_SCENARIO_EVIDENCE/);
}));

test('untracked source edits after gates invalidate PASS as well as tracked edits',()=>sandbox(async base=>{
  const git=(...args)=>spawnSync('git',args,{cwd:base,encoding:'utf8'});
  assert.equal(git('init','-q').status,0);await writeFile(join(base,'README.md'),'baseline\n');git('add','README.md');
  assert.equal(git('-c','user.email=test@example.com','-c','user.name=Test','commit','-qm','baseline').status,0);
  const source=join(base,'app','NewFeature.kt');await mkdir(dirname(source),{recursive:true});await writeFile(source,'fun feature() = 1\n');
  const {fb,planPath}=await fixture(base,{existingTests:[],scenarios:[]});
  assert.equal(run(base,fb,planPath).exit,0);assert.equal(gate(base,fb,'target',['--attempt','001']).exit,0);
  for(const name of ['existing-tests','regression'])assert.equal(call(base,['gate','--dir',fb,'--gate',name,'--status','NOT_APPLICABLE','--summary','No test cases','--evidence',name==='existing-tests'?'tests/discovery.json':'impact/plan.json']).exit,0);
  await writeFile(source,'fun feature() = 2\n');
  assert.equal(call(base,['finish','--dir',fb,'--status','PASS','--summary','Must not accept untracked changes']).code,'STALE_GATE');
}));

test('target gate cannot cite impact plan alone instead of actual passing attempt evidence',()=>sandbox(async base=>{
  const {fb,planPath}=await fixture(base);run(base,fb,planPath);
  const r=call(base,['gate','--dir',fb,'--gate','target','--status','PASS','--attempt','001','--evidence','impact/plan.json','--summary','No actual observed result']);
  assert.equal(r.code,'GATE_EVIDENCE_MISSING');
}));
