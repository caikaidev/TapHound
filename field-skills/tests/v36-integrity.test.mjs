import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {selectForArchive} from '../taphound-flash/scripts/feedback-pack-policy.mjs';
import {verifyCustomScenarioReport} from '../taphound-flash/scripts/regression-gates.mjs';
import {validateOracleReview} from '../taphound-flash/scripts/oracle-review.mjs';
const dirRoot=dirname(fileURLToPath(import.meta.url));
const feedback=join(dirRoot,'../taphound-flash/scripts/feedback.mjs');
const oracle={version:1,expectations:[{id:'summary-preview',scope:'target',when:'Tap Summary',then:'Show preview before explicit send',confidence:'supported',sources:[{kind:'requirement',ref:'User requirement: preview-first flow'},{kind:'source-code',ref:'AIChatViewModel.summaryMessage'}]},{id:'old-message',scope:'regression',when:'Return to AI',then:'New message is not confused with old result',confidence:'supported',sources:[{kind:'existing-test',ref:'TestOldMessage'}]}],uncertainties:[]};
async function sandbox(fn){const d=await mkdtemp(join(tmpdir(),'tap36-'));try{await fn(d);}finally{await rm(d,{recursive:true,force:true});}}
function cli(cwd,argv){const r=spawnSync(process.execPath,[feedback,...argv],{cwd,encoding:'utf8',timeout:20000});let json;try{json=JSON.parse(r.stdout);}catch{throw Error(r.stderr+'\n'+r.stdout)}return {...json,exit:r.status};}
const sample=(root)=>join(root,'feedback');
test('critical-first packer retains gates, summary and latest attempt, dropping bulk first',()=>{
 const entries=[{path:'attempts/001/evidence/logcat.txt',size:25},{path:'attempts/017/evidence/screenshot.png',size:40},{path:'attempts/017/attempt.json',size:5},{path:'gates/regression.json',size:4},{path:'summary.md',size:4},{path:'manifest.json',size:4},{path:'timeline.jsonl',size:5},{path:'index.json',size:5}];
 const r=selectForArchive(entries,{maxTotal:28,maxFile:100});
 for(const p of ['manifest.json','summary.md','index.json','timeline.jsonl','gates/regression.json','attempts/017/attempt.json'])assert.ok(r.included.some(e=>e.path===p),p);
 assert.equal(r.criticalOmitted.length,0);
 assert.ok(r.omitted.some(e=>e.path==='attempts/001/evidence/logcat.txt'));
});
test('oracle review rejects existing implementation as sole source of a new target requirement',()=>{
 const bad=structuredClone(oracle);bad.expectations[0].sources=[{kind:'source-code',ref:'Old buggy implementation'}];
 assert.throws(()=>validateOracleReview(bad),e=>e.code==='ORACLE_INVALID');
 assert.deepEqual(validateOracleReview(oracle),oracle);
});
test('pending asynchronous command exits zero but journal remains inconclusive',()=>sandbox(async root=>{
 const fb=sample(root);
 assert.equal(cli(root,['start','--dir',fb,'--skill','tap-check','--task','Async completion check']).exit,0);
 const cmd=`process.stdout.write(JSON.stringify({state:'running',exit_code:null,task_id:'job-123'}))`;
 const run=cli(root,['exec','--dir',fb,'--',process.execPath,'-e',cmd]);
 assert.equal(run.exit,4,JSON.stringify(run));assert.equal(run.status,'inconclusive');
 const attempt=JSON.parse(await readFile(join(fb,'attempts/001/attempt.json'),'utf8'));
 assert.equal(attempt.classification,'ASYNC_NOT_COMPLETED');
 assert.equal(attempt.commandLifecycle.complete,false);
 assert.equal(cli(root,['gate','--dir',fb,'--gate','target','--status','PASS','--attempt','001','--evidence','attempts/001/attempt.json','--summary','Claim completed']).code!=='',true);
}));
test('feedback zip always includes mandatory records and its own completeness index',()=>sandbox(async root=>{
 const fb=sample(root);
 assert.equal(cli(root,['start','--dir',fb,'--skill','tap-fix','--task','Archive completeness']).exit,0);
 const packed=JSON.parse(await readFile(join(fb,'zip-manifest.json'),'utf8'));
 assert.equal(packed.status,'complete');
 const zip=await readFile(join(fb,'feedback.zip'));
 for(const p of ['summary.md','manifest.json','timeline.jsonl','index.json','zip-manifest.json','zip-omissions.txt']) assert.ok(zip.includes(Buffer.from(p)),p);
}));
test('new oracle source review is versioned and uncertainty blocks a green completion',()=>sandbox(async root=>{
 const fb=sample(root);
 assert.equal(cli(root,['start','--dir',fb,'--skill','tap-check','--task','Oracle review']).exit,0);
 const file=join(root,'oracle.json');await writeFile(file,JSON.stringify(oracle));
 let response=cli(root,['oracle','--dir',fb,'--file',file]);assert.equal(response.exit,0,JSON.stringify(response));
 const first=JSON.parse(await readFile(join(fb,'oracle/current.json'),'utf8'));
 assert.ok(first.sha256);assert.ok((await readFile(join(fb,first.versionPath),'utf8')).includes('summary-preview'));
 const changed=structuredClone(oracle);changed.expectations[0].confidence='uncertain';
 await writeFile(file,JSON.stringify(changed));response=cli(root,['oracle','--dir',fb,'--file',file]);assert.equal(response.exit,0);
 const second=JSON.parse(await readFile(join(fb,'oracle/current.json'),'utf8'));
 assert.notEqual(first.sha256,second.sha256);
 assert.match(await readFile(join(fb,'timeline.jsonl'),'utf8'),/oracle-review/);
}));

test('custom regression claims must bind actual/expected to separately attached evidence',()=>{
 const legacy={version:1,scenarios:[{id:'B',status:'passed',assertions:['looked good']}]};
 assert.throws(()=>verifyCustomScenarioReport(legacy,'003',[]),e=>e.code==='CUSTOM_ASSERTION_UNVERIFIED');
 const report={version:2,scenarios:[{id:'B',status:'passed',assertions:[{id:'rendered',operator:'equals',expected:true,actual:true,evidence:'attempts/003/evidence/observed.json'}]}]};
 assert.throws(()=>verifyCustomScenarioReport(report,'003',[]),e=>e.code==='CUSTOM_ASSERTION_UNVERIFIED');
 const attached=[{path:'attempts/003/evidence/observed.json',sha256:'abc'}];
 const observed={'attempts/003/evidence/observed.json':{measurements:{rendered:true}}};
 assert.throws(()=>verifyCustomScenarioReport(report,'003',attached),e=>e.code==='CUSTOM_OBSERVATION_MISMATCH');
 assert.deepEqual(verifyCustomScenarioReport(report,'003',attached,observed),['B']);
 const changed=structuredClone(report);changed.scenarios[0].assertions[0].actual=false;
 assert.throws(()=>verifyCustomScenarioReport(changed,'003',attached,observed),e=>e.code==='CUSTOM_ASSERTION_UNVERIFIED');
 const falseObserved={'attempts/003/evidence/observed.json':{measurements:{rendered:false}}};
 assert.throws(()=>verifyCustomScenarioReport(report,'003',attached,falseObserved),e=>e.code==='CUSTOM_OBSERVATION_MISMATCH');
 const missingMeasurement={'attempts/003/evidence/observed.json':{measurements:{unrelated:true}}};
 assert.throws(()=>verifyCustomScenarioReport(report,'003',attached,missingMeasurement),e=>e.code==='CUSTOM_OBSERVATION_MISMATCH');
 const wrongDevice=structuredClone(report);wrongDevice.scenarios[0].assertions[0].evidence='attempts/004/evidence/observed.json';
 assert.throws(()=>verifyCustomScenarioReport(wrongDevice,'003',attached),e=>e.code==='CUSTOM_ASSERTION_UNVERIFIED');
});
