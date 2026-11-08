/** v3.6 feedback gates: immutable impact plans, machine-supported test results and scoped coverage.
 * Gate declarations describe Agent decisions; a PASS is only mechanically admissible when
 * it references actual passing attempts, a stable source snapshot and saved evidence.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat, copyFile, rename } from 'node:fs/promises';
import { join, relative, resolve, sep, basename } from 'node:path';
import {readOracleReview} from './oracle-review.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const error = (code, message) => Object.assign(new Error(message), { code });
const safeName = x => typeof x === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(x);
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function writeJsonAtomic(path, value) {
  await mkdir(resolve(path,'..'), {recursive:true});
  const tmp=`${path}.${randomUUID()}.tmp`;
  await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  await rename(tmp,path);
}
function requireInside(root, path) {
  const rel=relative(root,path);
  if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||rel.startsWith('/')||rel.startsWith('\\')) throw error('EVIDENCE_PATH_UNSAFE','Gate evidence must be inside the feedback directory');
  return rel.split(sep).join('/');
}
async function evidencePaths(dir, paths) {
  const found=[];
  for(const entry of paths){
    const path=resolve(dir,entry); const rel=requireInside(dir,path);
    const s=await stat(path).catch(()=>undefined);
    if(!s?.isFile())throw error('GATE_EVIDENCE_MISSING',`Evidence file is missing: ${rel}`);
    found.push({path:rel,sha256:sha(await readFile(path))});
  }
  return found;
}
const statuses=new Set(['PASS','FAIL','BLOCKED','INCONCLUSIVE','NOT_APPLICABLE']);
const gates=new Set(['target','existing-tests','regression']);
const risks=new Set(['critical','high','medium','low']);
function uniq(arr){return [...new Set(arr)];}
export async function saveImpact(dir, file, git) {
  const plan=await readJson(resolve(file));
  if(plan.version!==1||typeof plan.changeIntent!=='string'||!plan.changeIntent.trim()||typeof plan.target?.id!=='string'||!safeName(plan.target.id)||typeof plan.target?.expected!=='string'||!plan.target.expected.trim()||!Array.isArray(plan.scenarios)||!Array.isArray(plan.existingTests)||!Array.isArray(plan.risks)) throw error('IMPACT_INVALID','Impact plan requires version=1, changeIntent, target{id,expected}, scenarios[], existingTests[], risks[]');
  const ids=new Set();
  for(const s of plan.scenarios){
    if(!safeName(s.id)||ids.has(s.id)||!['preserve','changed'].includes(s.intent)||!risks.has(s.risk)||typeof s.description!=='string'||!s.description.trim()||typeof s.required!=='boolean') throw error('IMPACT_INVALID','Scenario needs unique id, intent, risk, description and explicit required boolean');
    ids.add(s.id);
  }
  if(ids.has(plan.target.id))throw error('IMPACT_INVALID','target must be separate from regression scenarios');
  const testIds=new Set();
  for(const t of plan.existingTests){
    if(!safeName(t.id)||testIds.has(t.id)||typeof t.command!=='string'||!t.command.trim()||typeof t.required!=='boolean')throw error('IMPACT_INVALID','Existing test needs unique id, command and required boolean');
    testIds.add(t.id);
  }
  for(const r of plan.risks){
    if(!safeName(r.id)||!risks.has(r.severity)||typeof r.reason!=='string'||typeof r.blocking!=='boolean')throw error('IMPACT_INVALID','Risk needs id, severity, reason, blocking');
  }
  const raw=Buffer.from(JSON.stringify(plan,null,2)+'\n');
  const digest=sha(raw);
  const dirPath=join(dir,'impact'); await mkdir(join(dirPath,'versions'),{recursive:true});
  const version=`versions/${Date.now()}-${digest.slice(0,10)}.json`;
  await writeFile(join(dirPath,version),raw,{flag:'wx',mode:0o600});
  await writeJsonAtomic(join(dirPath,'current.json'),{version:1,sha256:digest,versionPath:`impact/${version}`,registeredAt:new Date().toISOString(),gitFingerprint:codeFingerprint(git)});
  await writeJsonAtomic(join(dirPath,'plan.json'),plan);
  return {sha256:digest,versionPath:`impact/${version}`,requiredScenarios:plan.scenarios.filter(s=>s.required).map(s=>s.id),requiredTests:plan.existingTests.filter(t=>t.required).map(t=>t.id)};
}
export async function currentImpact(dir) {
  const index=await readJson(join(dir,'impact','current.json')).catch(()=>undefined);
  if(!index)throw error('IMPACT_REQUIRED','Record an impact plan before any PASS/FIXED gate');
  const plan=await readJson(join(dir,'impact','plan.json'));
  if(sha(Buffer.from(JSON.stringify(plan,null,2)+'\n'))!==index.sha256)throw error('IMPACT_MUTATED','Current impact plan changed outside the versioned recorder');
  return {index,plan};
}
export function codeFingerprint(git){
  if(git?.available===false||!git?.head)return null;
  return sha(JSON.stringify({head:git.head,diffSha256:git.diffSha256,stagedDiffSha256:git.stagedDiffSha256,
    // Content changes are covered by diff hashes; status is retained for untracked files.
    untrackedContentSha256:git.untrackedContentSha256,untracked:(git.status??'').split('\n').filter(line=>line.startsWith('?? ')).sort()}));
}
function parseAttr(tag, attr) {const m=tag.match(new RegExp(`\\b${attr}=["'](\\d+)["']`));return m?Number(m[1]):undefined;}
export function parseTestReport(text, path){
  // Reports are never inferred from a naked exit code or "BUILD SUCCESSFUL".
  const suites=[...text.matchAll(/<testsuite\b([^>]*)>/g)];
  if(suites.length){
    const all=text.match(/<testsuites\b([^>]*)>/)?.[1];
    let count,fail,skip;
    if(all && parseAttr(all,'tests')!==undefined){count=parseAttr(all,'tests'); fail=(parseAttr(all,'failures')??0)+(parseAttr(all,'errors')??0);skip=parseAttr(all,'skipped')??0;}
    else {
      // Each file normally contains a root testsuite; select that to avoid nested double-counting.
      const top=suites[0][1];count=parseAttr(top,'tests');fail=(parseAttr(top,'failures')??0)+(parseAttr(top,'errors')??0);skip=parseAttr(top,'skipped')??0;
    }
    if(Number.isInteger(count)&&count>=0&&Number.isInteger(fail)&&Number.isInteger(skip))return {format:'junit',tests:count,failures:fail,skipped:skip,passed:Math.max(0,count-fail-skip),source:path};
  }
  // node --test TAP summary. Ignore subtest summaries; final aggregate is last match.
  const matches={tests:[...text.matchAll(/^# tests (\d+)\s*$/gm)],pass:[...text.matchAll(/^# pass (\d+)\s*$/gm)],fail:[...text.matchAll(/^# fail (\d+)\s*$/gm)],skip:[...text.matchAll(/^# skipped (\d+)\s*$/gm)]};
  if(matches.tests.length && matches.pass.length && matches.fail.length){
    const last=k=>Number(matches[k].at(-1)[1]);return {format:'node-tap',tests:last('tests'),passed:last('pass'),failures:last('fail'),skipped:matches.skip.length?last('skip'):0,source:path};
  }
  throw error('TEST_REPORT_UNRECOGNIZED',`Cannot parse actual test counts from ${path}; supply JUnit XML or Node TAP output`);
}
async function captureTestReports(dir, list, firstAttemptAt){
  const results=[];
  await mkdir(join(dir,'tests','reports'),{recursive:true});
  for(const path of list){
    const source=resolve(path), info=await stat(source).catch(()=>undefined);
    if(!info?.isFile()||info.size>4*1024*1024)throw error('TEST_REPORT_MISSING',`Test report missing or too large: ${source}`);
    if(firstAttemptAt && info.mtimeMs < firstAttemptAt-1500)throw error('TEST_REPORT_STALE',`Test report predates the recorded test attempt: ${source}`);
    const bytes=await readFile(source), digest=sha(bytes);
    const parsed=parseTestReport(bytes.toString('utf8'),source);
    const file=join(dir,'tests','reports',`${Date.now()}-${randomUUID().slice(0,8)}-${basename(path).replace(/[^\w.-]/g,'_')}`);
    await copyFile(source,file);
    results.push({...parsed,sha256:digest,saved:requireInside(dir,file)});
  }
  return results;
}
async function readAttempt(dir,id){
  if(!/^\d{3,}$/.test(id))throw error('ATTEMPT_INVALID',`Invalid attempt id ${id}`);
  const value=await readJson(join(dir,'attempts',id,'attempt.json')).catch(()=>undefined);
  if(!value)throw error('ATTEMPT_INVALID',`Attempt ${id} was not recorded`);
  return value;
}
async function saveGateSnapshot(dir,gate,record){
  const root=join(dir,'gates');await mkdir(join(root,'history'),{recursive:true});
  await writeFile(join(root,'history',`${Date.now()}-${gate}-${randomUUID().slice(0,8)}.json`),JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
  await writeJsonAtomic(join(root,`${gate}.json`),record);
}
export async function gate(dir,input,git,deviceBinding){
  if(!gates.has(input.gate)||!statuses.has(input.status))throw error('GATE_INVALID','gate needs --gate target|existing-tests|regression and --status PASS|FAIL|INCONCLUSIVE|BLOCKED|NOT_APPLICABLE');
  const {index,plan}=await currentImpact(dir);
  const selected=uniq(input.attempts??[]);
  const attached=await evidencePaths(dir,input.evidence??[]);
  if(!input.summary?.trim())throw error('GATE_INVALID','Each gate requires --summary');
  if(!attached.length)throw error('GATE_EVIDENCE_MISSING','Each gate needs evidence files saved inside the feedback directory');
  const attempts=await Promise.all(selected.map(id=>readAttempt(dir,id)));
  const fingerprint=codeFingerprint(git);
  const isPass=input.status==='PASS';
  let oracleHash=null;
  if(isPass && (input.gate==='target'||input.gate==='regression')) {
    const saved=await readOracleReview(dir).catch(e=>{if(e?.code==='ENOENT')throw error('ORACLE_REQUIRED','Record oracle review with source-backed expectations before target/regression PASS');throw e;});
    const scope=input.gate==='target'?'target':'regression';
    if(saved.review.expectations.some(x=>x.scope===scope&&x.confidence==='uncertain')||saved.review.uncertainties.some(x=>x.blocking))throw error('ORACLE_UNRESOLVED','Essential expectation provenance is uncertain; cannot mark gate PASS');
    if(!saved.review.expectations.some(x=>x.scope===scope&&x.confidence==='supported'))throw error('ORACLE_UNSUPPORTED',`No supported ${scope} expectation with provenance`);
    oracleHash=saved.current.sha256;
  }
  if(isPass&&selected.length===0)throw error('GATE_ATTEMPT_MISSING','PASS gate requires --attempt NNN');
  if(isPass&&!attached.some(e=>selected.some(id=>e.path.startsWith(`attempts/${id}/`))))throw error('GATE_EVIDENCE_MISSING','PASS gate needs evidence from the referenced passing attempt, not just a plan or agent note');
  if(isPass&&attempts.some(a=>a.status!=='passed'||a.oracleChangedDuringRun||a.apkAgreement==='mismatched'))throw error('GATE_ATTEMPT_FAILED','PASS gate requires successful attempts, unchanged test oracles and no APK mismatch');
  if(isPass&&deviceBinding && attempts.some(a=>a.device && a.device!==deviceBinding))throw error('DEVICE_CONFLICT','Gate attempt used a different device');
  if(input.status==='NOT_APPLICABLE'&&input.gate==='target')throw error('GATE_INVALID','Target verification cannot be not-applicable');
  let reports=[];
  if(input.gate==='existing-tests'){
    const relevant=plan.existingTests.filter(t=>t.required).map(t=>t.id);
    if(input.status==='NOT_APPLICABLE'){
      if(relevant.length)throw error('GATE_INVALID','Cannot skip required existing tests');
      const discovery=await readJson(join(dir,'tests','discovery.json')).catch(()=>undefined);
      if(!discovery||discovery.version!==1||!discovery.scanComplete||!discovery.affectedSources?.length)
        throw error('TEST_DISCOVERY_REQUIRED','Existing tests N/A requires a complete source-scoped test discovery snapshot; run feedback discover');
      if(discovery.candidateTests?.length)
        throw error('TEST_CANDIDATES_UNREVIEWED',`Existing tests N/A refused: ${discovery.candidateTests.length} potential related tests were found`);
      if(!attached.some(e=>e.path==='tests/discovery.json'))
        throw error('TEST_DISCOVERY_EVIDENCE','Attach --evidence tests/discovery.json for NOT_APPLICABLE');
      if(fingerprint!==null&&discovery.gitFingerprint!==fingerprint)
        throw error('STALE_DISCOVERY','Tests were discovered before the current source changes; rerun feedback discover');
      const plannedSources=(plan.changedSymbols??[]).map(x=>x.file).filter(Boolean);
      const missing=plannedSources.filter(file=>!discovery.affectedSources.includes(file.replaceAll('\\','/')));
      if(missing.length)throw error('TEST_DISCOVERY_INCOMPLETE',`Test discovery did not cover changed source files: ${missing.join(', ')}`);
    }else if(isPass){
      if(relevant.some(id=>!(input.tests??[]).includes(id)))throw error('GATE_COVERAGE_MISSING',`Required existing tests not covered: ${relevant.filter(id=>!(input.tests??[]).includes(id)).join(', ')}`);
      reports=await captureTestReports(dir,input.reports??[],Math.min(...attempts.map(x=>Date.parse(x.startedAt))));
      if(!reports.length||reports.reduce((n,r)=>n+r.tests,0)===0||reports.some(r=>r.failures>0||r.passed===0))throw error('TEST_REPORT_EMPTY','Existing tests PASS needs a nonempty machine report with no failures and at least one passed test');
    }
  }
  if(input.gate==='regression'){
    const required=plan.scenarios.filter(s=>s.required).map(s=>s.id);
    if(input.status==='NOT_APPLICABLE'&&required.length)throw error('GATE_INVALID','Cannot skip required regressions');
    if(isPass&&required.some(id=>!(input.scenarios??[]).includes(id)))throw error('GATE_COVERAGE_MISSING',`Required regression scenarios not covered: ${required.filter(id=>!(input.scenarios??[]).includes(id)).join(', ')}`);
    if((input.scenarios??[]).some(id=>!plan.scenarios.some(s=>s.id===id)))throw error('GATE_INVALID','Unknown regression scenario');
    if(isPass){
      const target=await readJson(join(dir,'gates','target.json')).catch(()=>undefined);
      if(target?.attempts?.some(id=>selected.includes(id)))throw error('GATE_ATTEMPT_REUSED','Regression must be separately executed from target acceptance');
      const declared=new Set();
      for(const id of selected){
        const runPlan=await readJson(join(dir,'attempts',id,'plan.snapshot.json')).catch(()=>undefined);
        if(!runPlan)continue;
        const result=await readJson(join(dir,'attempts',id,'evidence','field-result.json')).catch(async()=>await readJson(join(dir,'attempts',id,'evidence','result.json')).catch(()=>undefined));
        for(const check of runPlan.scenarioChecks??[]){
          if(!runPlan.scenarioIds?.includes(check.id)||!Array.isArray(check.assertionSteps)||!check.assertionSteps.length)continue;
          if(check.assertionSteps.every(index=>Number.isInteger(index)&&['expect','expectActivity'].includes(runPlan.steps?.[index]?.action)&&result?.steps?.some(step=>step.index===index&&step.status==='passed'&&step.action===runPlan.steps[index].action)))declared.add(check.id);
        }
      }
      for(const entry of attached){
        if(!/^attempts\/\d+\/evidence\//.test(entry.path))continue;
        const attempt=entry.path.split('/')[1];if(!selected.includes(attempt))continue;
        const data=await readJson(join(dir,entry.path)).catch(()=>undefined);
        if(data?.version!==1||!Array.isArray(data?.scenarios))continue;
        for(const scenario of data.scenarios){
          if(scenario?.status==='passed'&&typeof scenario?.id==='string'&&Array.isArray(scenario?.assertions)&&scenario.assertions.length>0)declared.add(scenario.id);
        }
      }
      if((input.scenarios??[]).some(id=>!declared.has(id)))throw error('GATE_SCENARIO_EVIDENCE','Regression scenario IDs must be present in a frozen device plan scenarioIds[] or a passing attempt evidence/scenario-results.json with positive assertions');
    }
  }
  if(input.gate==='target'&&isPass && (input.scenarios?.length||input.tests?.length))throw error('GATE_INVALID','Target gate does not accept regression scenarios or test ids');
  const result={version:1,gate:input.gate,status:input.status,summary:input.summary,recordedAt:new Date().toISOString(),impactSha256:index.sha256,codeFingerprint:fingerprint,attempts:selected,evidence:attached,reports,scenarios:uniq(input.scenarios??[]),tests:uniq(input.tests??[]),device:deviceBinding??null,...(oracleHash?{oracleSha256:oracleHash}:{})};
  await saveGateSnapshot(dir,input.gate,result);
  return {gate:input.gate,status:input.status,attempts:selected,reports:reports.map(x=>({tests:x.tests,passed:x.passed,failures:x.failures})),impactSha256:index.sha256};
}
export async function readGates(dir){
  const result={};for(const key of gates)result[key]=await readJson(join(dir,'gates',`${key}.json`)).catch(()=>null);return result;
}
export async function validateCompletion(dir,mode,git,attempts,events,deviceBinding){
  const {index,plan}=await currentImpact(dir);
  const list=await readGates(dir);
  const fingerprint=codeFingerprint(git);
  const oracle=await readOracleReview(dir).catch(e=>{if(e?.code==='ENOENT')throw error('ORACLE_REQUIRED','Record source-backed oracle review before successful completion');throw e;});
  if(git?.available!==false&&git?.sourceSnapshotComplete===false)throw error('SOURCE_SNAPSHOT_INCOMPLETE','Source inventory is incomplete (too many, large or unreadable untracked files); do not claim PASS/FIXED from unverified source state');
  for(const key of gates){
    const g=list[key];
    if(!g||!['PASS','NOT_APPLICABLE'].includes(g.status))throw error('GATE_INCOMPLETE',`Cannot ${mode}; ${key} gate has not passed`);
    if(g.impactSha256!==index.sha256)throw error('STALE_GATE',`${key} gate belongs to an older impact plan`);
    if((key==='target'||key==='regression')&&g.status==='PASS'&&g.oracleSha256!==oracle.current.sha256)throw error('STALE_ORACLE','Oracle source or expectation changed after the gate; rerun affected tests');
    if(fingerprint!==null&&g.codeFingerprint!==fingerprint)throw error('STALE_GATE',`${key} gate was recorded before source changes; rerun tests`);
    if(deviceBinding && g.device!==deviceBinding && !(g.status==='NOT_APPLICABLE' && g.device===null))throw error('DEVICE_CONFLICT',`${key} gate device binding changed`);
    for(const e of g.evidence){
      const file=resolve(dir,e.path);requireInside(dir,file);
      const content=await readFile(file).catch(()=>undefined);
      if(!content||sha(content)!==e.sha256)throw error('GATE_EVIDENCE_CHANGED',`${key} gate evidence was deleted or modified`);
    }
    if(g.status==='PASS'){
      for(const a of g.attempts){
        const actual=await readAttempt(dir,a);
        if(actual.status!=='passed'||actual.oracleChangedDuringRun||actual.apkAgreement==='mismatched')throw error('GATE_ATTEMPT_FAILED',`Gate ${key} attempt ${a} was not passed`);
      }
    }
  }
  if(plan.risks.some(r=>r.blocking))throw error('BLOCKING_RISK','Impact plan contains blocking unverified risks');
  const requiredTests=plan.existingTests.filter(t=>t.required).map(t=>t.id);
  const requiredRegressions=plan.scenarios.filter(s=>s.required).map(s=>s.id);
  if(requiredTests.some(t=>!list['existing-tests'].tests.includes(t)))throw error('GATE_COVERAGE_MISSING','Not all required existing tests are covered');
  if(requiredRegressions.some(s=>!list.regression.scenarios.includes(s)))throw error('GATE_COVERAGE_MISSING','Not all required regression scenarios are covered');
  if(mode==='FIXED'){
    const claims=events.filter(e=>e.type==='reproduction-confirmed'&&e.attempt&&e.evidence);
    const greenId=list.target.attempts.at(-1),green=await readAttempt(dir,greenId);
    if(!claims.length)throw error('VERDICT_UNSUPPORTED','FIXED requires a confirmed RED reproduction');
    const red=attempts.find(a=>claims.some(e=>e.attempt===a.name)&&a.status==='failed'&&a.exitCode!==127&&a.type===green.type&&a.oracleSha256===green.oracleSha256);
    if(!red||Number(red.name)>=Number(greenId))throw error('VERDICT_UNSUPPORTED','FIXED requires preceding confirmed RED and target GREEN using the exact same frozen oracle');
    if(red.oracleChangedDuringRun||green.oracleChangedDuringRun)throw error('VERDICT_UNSUPPORTED','RED/GREEN test oracle changed during execution');
    if(green.type==='command'&&!green.oracleFiles?.some(f=>f.available))throw error('VERDICT_UNSUPPORTED','FIXED via exec requires a saved script or explicit test source');
    if(green.type==='command'&&/gradlew|mvnw|npm|pnpm|yarn/i.test(green.command.join(' '))&&green.explicitOracleCount<1)throw error('VERDICT_UNSUPPORTED','Test wrapper requires explicit --oracle-file');
  }
  return {impactSha256:index.sha256,gates:list};
}
