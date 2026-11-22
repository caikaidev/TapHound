import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {validateTarget,parseUiXml,selectMatches,centerOf,targetXpath} from '../taphound-flash/scripts/ui-locator.mjs';
import {discoverTests} from '../taphound-flash/scripts/test-discovery.mjs';
const dir=dirname(fileURLToPath(import.meta.url));
const scripts=join(dir,'..','taphound-flash','scripts');
async function sandbox(fn){const root=await mkdtemp(join(tmpdir(),'tap-v35-'));try{await fn(root)}finally{await rm(root,{recursive:true,force:true})}}
function run(file,args,options={}){return spawnSync(process.execPath,[join(scripts,file),...args],{encoding:'utf8',timeout:15000,...options});}
const pkg='dev.demo.app';
const xml=`<?xml version="1.0"?><hierarchy><node package="${pkg}" bounds="[0,0][1080,1920]" clickable="false"><node resource-id="${pkg}:id/messages" text="Inbox" content-desc="Messages, 46 new notifications" bounds="[200,300][800,500]" clickable="true" enabled="true"/><node resource-id="${pkg}:id/other" text="More" content-desc="More" bounds="[100,600][300,700]" clickable="true"/></node></hierarchy>`;
test('shared locator supports dynamic content-description prefix with exact pixel center and no comma-split',()=>{
  const nodes=parseUiXml(xml,pkg);
  assert.equal(selectMatches(nodes,{desc:'Messages'},pkg).length,0);
  const found=selectMatches(nodes,{desc:'Messages',match:'prefix'},pkg);
  assert.equal(found.length,1);
  assert.deepEqual(centerOf(found[0]),{x:500,y:400});
});
test('locator supports regex, contains, and rejects malformed target or ambiguous matches',()=>{
  const nodes=parseUiXml(xml,pkg);
  assert.equal(selectMatches(nodes,{desc:'Messages, [0-9]+ new notifications',match:'regex'}).length,1);
  assert.equal(selectMatches(nodes,{id:'messages'}).length,1);
  assert.equal(selectMatches(nodes,{text:'nbo',match:'contains'}).length,1);
  assert.throws(()=>validateTarget({desc:'hi',match:'regex',text:'x'}),/exactly one/);
  assert.throws(()=>validateTarget({desc:'[',match:'regex'}),/regex/);
  assert.match(targetXpath({desc:'Messages',match:'prefix'},pkg),/starts-with/);
});
test('XML parser decodes numeric entities and clips touch to ancestors',()=>{
  const nodes=parseUiXml(`<hierarchy><node package="${pkg}" bounds="[10,10][100,100]" clickable="true"><node package="${pkg}" text="A&#44; B&#x26; C" bounds="[50,50][300,400]" enabled="true"/></node></hierarchy>`,pkg);
  const found=selectMatches(nodes,{text:'A, B& C'});
  assert.equal(found.length,1);assert.deepEqual(centerOf(found[0]),{x:75,y:75});
});
test('Appium hierarchy variant can be parsed for regex matching',()=>{
  const source=`<hierarchy><android.widget.FrameLayout package="${pkg}" bounds="[0,0][1000,1200]" clickable="true"><android.widget.TextView package="${pkg}" content-desc="Messages, 46 new notifications" bounds="[20,40][220,140]"/></android.widget.FrameLayout></hierarchy>`;
  const matches=selectMatches(parseUiXml(source,pkg,{appium:true}),{desc:'Messages, [0-9]+ new',match:'regex'});
  assert.equal(matches.length,1);assert.deepEqual(centerOf(matches[0],{requireClickable:false}),{x:120,y:90});
});
test('device guard parses global selector only; adb logcat -d is allowed',()=>sandbox(async root=>{
  const fake=join(root,'fake-adb.mjs'),output=join(root,'args.txt');
  await writeFile(fake,`#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';writeFileSync(process.env.CAPTURE_ARGS,JSON.stringify(process.argv.slice(2)));`);await chmod(fake,0o755);
  const env={...process.env,TAPHOUND_DEVICE_SERIAL:'A123',TAPHOUND_REAL_ADB:fake,CAPTURE_ARGS:output};
  let r=run('device-guard.mjs',['-s','A123','logcat','-d','-b','crash'],{env});assert.equal(r.status,0,r.stderr);
  assert.deepEqual(JSON.parse(await readFile(output,'utf8')),['-s','A123','logcat','-d','-b','crash']);
  r=run('device-guard.mjs',['logcat','-d'],{env});assert.equal(r.status,0,r.stderr);
  assert.deepEqual(JSON.parse(await readFile(output,'utf8')),['-s','A123','logcat','-d']);
  r=run('device-guard.mjs',['-s','OTHER','shell','input','tap','1','2'],{env});assert.equal(r.status,96);assert.match(r.stderr,/different device/);
  r=run('device-guard.mjs',['-d','shell','input','tap','1','2'],{env});assert.equal(r.status,96);
  r=run('device-guard.mjs',['devices','-l'],{env});assert.equal(r.status,0);assert.deepEqual(JSON.parse(await readFile(output,'utf8')),['devices','-l']);
}));
test('logcat-dump records real command failure separately from zero matching events',()=>sandbox(async root=>{
  const fake=join(root,'fake-adb.mjs'),out=join(root,'logcat.txt');
  await writeFile(fake,`#!/usr/bin/env node\nif(process.env.FAIL_LOGCAT==='1'){process.stderr.write('logcat inaccessible');process.exit(7)}console.log('11-05 21:00:00.000  123  123 I CustomLogger: loaded');`);await chmod(fake,0o755);
  let r=run('logcat-dump.mjs',['--device','A123','--out',out],{env:{...process.env,ADB:fake,FAIL_LOGCAT:'1'}});
  assert.equal(r.status,2);assert.match(r.stdout,/LOGCAT_CAPTURE_FAILED/);
  r=run('logcat-dump.mjs',['--device','A123','--out',out],{env:{...process.env,ADB:fake}});
  assert.equal(r.status,0,r.stdout);assert.match(await readFile(out,'utf8'),/CustomLogger/);
}));
test('test discovery finds same-module and cross-module symbol references (not only matching filenames)',()=>sandbox(async root=>{
  await mkdir(join(root,'app/src/main/java'),{recursive:true});await mkdir(join(root,'app/src/test/java'),{recursive:true});await mkdir(join(root,'feature/src/test/java'),{recursive:true});
  await writeFile(join(root,'app/src/main/java/SharedStore.kt'),'class SharedStore { fun update() {} }');
  await writeFile(join(root,'app/src/test/java/OtherTest.kt'),'class OtherTest { fun verify() {} }');
  await writeFile(join(root,'feature/src/test/java/CallerTest.kt'),'class CallerTest { fun case() = SharedStore().update() }');
  const r=await discoverTests(root,['app/src/main/java/SharedStore.kt']);
  assert.equal(r.scanComplete,true);assert.equal(r.inventory.testFiles,2);
  assert.deepEqual(new Set(r.candidateTests.map(x=>x.path)),new Set(['app/src/test/java/OtherTest.kt','feature/src/test/java/CallerTest.kt']));
}));
test('N/A gate refuses existing tests discovery with potential candidates',()=>sandbox(async root=>{
  await mkdir(join(root,'app/src/test'),{recursive:true});await mkdir(join(root,'app/src/main'),{recursive:true});await writeFile(join(root,'app/src/main/Feature.kt'),'class Feature {}');
  await writeFile(join(root,'app/src/test/LegacyTest.kt'),'class LegacyTest {}');
  const fb=join(root,'feedback');
  const impact=join(root,'impact.json');await writeFile(impact,JSON.stringify({version:1,changeIntent:'change',target:{id:'A',expected:'works'},changedSymbols:[{file:'app/src/main/Feature.kt',symbol:'Feature'}],scenarios:[],existingTests:[],risks:[]}));
  const call=args=>run('feedback.mjs',args,{cwd:root});
  assert.equal(call(['start','--dir',fb,'--skill','tap-check','--task','test']).status,0);
  assert.equal(call(['impact','--dir',fb,'--file',impact]).status,0);
  const discovered=call(['discover','--dir',fb,'--project',root]);assert.equal(discovered.status,0,discovered.stdout);
  const bad=call(['gate','--dir',fb,'--gate','existing-tests','--status','NOT_APPLICABLE','--summary','none','--evidence','tests/discovery.json']);
  assert.equal(bad.status,2);assert.match(bad.stdout,/TEST_CANDIDATES_UNREVIEWED/);
}));

test('an external command cannot PASS when required Logcat capture fails',()=>sandbox(async root=>{
  const fake=join(root,'fail-adb.mjs');await writeFile(fake,`#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a.includes('logcat')){process.stderr.write('logcat permission denied');process.exit(9)}if(a.includes('screencap')){process.stdout.write('PNG')}else if(a.includes('cat')){process.stdout.write('<hierarchy><node package="dev.demo.app" bounds="[0,0][100,100]"/></hierarchy>')}else if(a.includes('pm')){process.stdout.write('package:/data/app/demo/base.apk')}else console.log('ok');`);await chmod(fake,0o755);
  const fb=join(root,'feedback'),call=args=>run('feedback.mjs',args,{cwd:root,env:{...process.env,ADB:fake}});
  assert.equal(call(['start','--dir',fb,'--skill','tap-check','--task','capture failure','--device','A123']).status,0);
  const result=call(['exec','--dir',fb,'--package','dev.demo.app','--require-logcat','--',process.execPath,'-e','process.exit(0)']);
  assert.equal(result.status,4,result.stdout);
  const attempt=JSON.parse(await readFile(join(fb,'attempts/001/attempt.json'),'utf8'));
  assert.equal(attempt.status,'inconclusive');assert.equal(attempt.classification,'LOGCAT_EVIDENCE_UNAVAILABLE');
  const capture=JSON.parse(await readFile(join(fb,'attempts/001/evidence/capture-manifest.json'),'utf8'));
  assert.equal(capture.logcat.status,'unavailable');
}));

test('shell script syntax errors are classified separately from application regressions',()=>sandbox(async root=>{
  const fb=join(root,'feedback'),call=args=>run('feedback.mjs',args,{cwd:root});
  assert.equal(call(['start','--dir',fb,'--skill','tap-fix','--task','classify script']).status,0);
  const script=join(root,'repro.sh');await writeFile(script,'#!/bin/sh\necho "syntax error" 1>&2\nexit 2\n');
  const result=call(['exec','--dir',fb,'--','sh',script]);assert.equal(result.status,1);
  const attempt=JSON.parse(await readFile(join(fb,'attempts/001/attempt.json'),'utf8'));
  assert.equal(attempt.classification,'SCRIPT_ERROR');
}));
