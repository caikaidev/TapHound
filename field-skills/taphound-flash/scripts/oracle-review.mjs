/** v3.6 small, versioned test-expectation provenance. No user approval required. */
import {createHash, randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fault=(code,message)=>Object.assign(new Error(message),{code});
const refKinds=new Set(['requirement','bug-report','existing-test','source-code','runtime-evidence']);
const name=x=>typeof x==='string'&&/^[a-zA-Z][\w-]{0,79}$/.test(x);
export function validateOracleReview(value) {
  if(!value||value.version!==1||!Array.isArray(value.expectations)||!value.expectations.length||!Array.isArray(value.uncertainties))throw fault('ORACLE_INVALID','Oracle review requires version=1, nonempty expectations[], uncertainties[]');
  const ids=new Set();
  for(const e of value.expectations){
    if(!name(e?.id)||ids.has(e.id)||!['target','regression'].includes(e.scope)||typeof e.when!=='string'||!e.when.trim()||typeof e.then!=='string'||!e.then.trim()||!['supported','uncertain'].includes(e.confidence)||!Array.isArray(e.sources)||!e.sources.length)throw fault('ORACLE_INVALID','Each expectation requires a unique id, scope, when/then, confidence and sources');
    ids.add(e.id);
    if(e.sources.some(s=>!refKinds.has(s?.kind)||typeof s.ref!=='string'||!s.ref.trim()))throw fault('ORACLE_INVALID','Each expectation source needs kind and a concrete reference');
    if(e.scope==='target'&&e.sources.every(s=>s.kind==='source-code'||s.kind==='runtime-evidence'))throw fault('ORACLE_INVALID','A target requirement cannot be inferred solely from the current implementation or observations');
  }
  for(const u of value.uncertainties){if(!name(u?.id)||typeof u.reason!=='string'||!u.reason.trim()||typeof u.blocking!=='boolean')throw fault('ORACLE_INVALID','uncertainties[] entries require id, reason, blocking');}
  return value;
}
export async function saveOracleReview(dir,file) {
  const review=validateOracleReview(JSON.parse(await readFile(resolve(file),'utf8')));
  const bytes=Buffer.from(JSON.stringify(review,null,2)+'\n');const digest=sha(bytes);
  const root=join(dir,'oracle');await mkdir(join(root,'versions'),{recursive:true});
  const version=`versions/${Date.now()}-${randomUUID().slice(0,8)}.json`;
  await writeFile(join(root,version),bytes,{flag:'wx',mode:0o600});
  const tmp=join(root,`.current-${randomUUID()}.tmp`);
  await writeFile(tmp,JSON.stringify({version:1,sha256:digest,versionPath:`oracle/${version}`,at:new Date().toISOString()},null,2)+'\n',{flag:'wx',mode:0o600});await rename(tmp,join(root,'current.json'));
  const planTmp=join(root,`.plan-${randomUUID()}.tmp`);await writeFile(planTmp,bytes,{flag:'wx',mode:0o600});await rename(planTmp,join(root,'plan.json'));
  return {sha256:digest,versionPath:`oracle/${version}`,expectations:review.expectations.length,uncertain:review.expectations.filter(e=>e.confidence==='uncertain').map(e=>e.id),blocking:review.uncertainties.filter(u=>u.blocking).map(u=>u.id)};
}
export async function readOracleReview(dir) {
  const current=await JSON.parse(await readFile(join(dir,'oracle','current.json'),'utf8'));
  const review=validateOracleReview(JSON.parse(await readFile(join(dir,'oracle','plan.json'),'utf8')));
  if(sha(Buffer.from(JSON.stringify(review,null,2)+'\n'))!==current.sha256)throw fault('ORACLE_MUTATED','Oracle review was modified outside versioned journal');
  return {current,review};
}
