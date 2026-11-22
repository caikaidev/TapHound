#!/usr/bin/env node
/** TapHound v3.6 append-only local feedback journal and evidence packager.
 * No npm dependencies. Does not transmit any data; ZIP is local and may contain secrets.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, readdir, stat, copyFile, open, rename, chmod } from 'node:fs/promises';
import { resolve, join, dirname, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import process from 'node:process';
import {saveImpact, gate as recordGate, validateCompletion, readGates, codeFingerprint} from './regression-gates.mjs';
import {discoverTests} from './test-discovery.mjs';
import {selectForArchive} from './feedback-pack-policy.mjs';
import {saveOracleReview,readOracleReview} from './oracle-review.mjs';

const execFileAsync = promisify(execFile);
const SELF = dirname(fileURLToPath(import.meta.url));
const JSONL = 'timeline.jsonl';
const MAX_ZIP_BYTES = 70 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_ORACLE_BYTES = 512 * 1024;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const EVIDENCE_TIMEOUT_MS = 9500;
const ACCEPTED = new Set(['PASS','FAIL','INCONCLUSIVE','BLOCKED','FIXED','NOT_REPRODUCED','FAILED']);
const TYPES = new Set(['observation','diagnosis','code-change','plan-changed','assertion-changed','backend-changed','reproduction-confirmed','retry','environment','instrumentation','risk','note','build','install','verification-gap','oracle-error','impact-changed','test-discovery','regression-plan','regression-failure','test-failure','device-binding']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const errText = err => err instanceof Error ? err.message : String(err);
const now = () => new Date().toISOString();
function fault(code, message) { return Object.assign(new Error(message), { code }); }
function print(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }
function parse(argv) {
  const [command, ...args] = argv;
  if (!['start','event','run','exec','finish','status','attach','impact','gate','discover','oracle'].includes(command)) throw fault('USAGE','Usage: feedback.mjs start|event|run|exec|impact|oracle|discover|gate|finish|status|attach --dir PATH [options]');
  const o = { command, flags: {}, positional: [], oracleFiles: [], attempts: [], scenarios: [], tests: [], reports: [], evidence: [], sources: [], symbols: [] };
  let afterDash = false;
  for (let i=0;i<args.length;i++) {
    if (args[i] === '--') { afterDash = true; continue; }
    if (afterDash) { o.positional.push(args[i]); continue; }
    if (!args[i].startsWith('--')) throw fault('USAGE',`Unexpected argument ${args[i]}; use -- to separate exec command`);
    const key = args[i].slice(2);
    if (['require-crash-check','require-logcat'].includes(key)) { o.flags[key] = true; continue; }
    if (!['dir','skill','task','type','summary','details','file','label','plan','device','backend','status','runner','oracle-file','apk','package','attempt','evidence','gate','scenario','test','test-report','project','source','symbol'].includes(key)) throw fault('USAGE',`Unknown flag: ${args[i]}`);
    const v = args[++i];
    if (!v || v.startsWith('--')) throw fault('USAGE',`Missing value for --${key}`);
    if(key === 'source') o.sources.push(v); else if(key === 'symbol') o.symbols.push(v); else if (key === 'oracle-file') o.oracleFiles.push(v); else if(key === 'attempt' && command==='gate') o.attempts.push(v); else if(key === 'scenario') o.scenarios.push(v); else if(key === 'test') o.tests.push(v); else if(key === 'test-report') o.reports.push(v); else if(key === 'evidence' && command==='gate') o.evidence.push(v); else o.flags[key] = v;
  }
  if (!o.flags.dir) throw fault('USAGE','--dir is required');
  o.dir = resolve(o.flags.dir);
  return o;
}
function assertInside(root, path) {
  const rel = relative(root,path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('/') || rel.includes(`..${sep}`)) throw fault('PATH_UNSAFE','File is outside feedback directory');
  return rel;
}
async function atomicJson(path,value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value,null,2)+'\n', {flag:'wx',mode:0o600});
  await rename(temp,path);
}
async function readJson(path) { return JSON.parse(await readFile(path,'utf8')); }
async function loaded(dir) {
  try { const m = await readJson(join(dir,'manifest.json')); if (m.schemaVersion !== 1) throw fault('INVALID_FEEDBACK','Unsupported manifest'); return m; }
  catch(e) { if (e?.code === 'ENOENT') throw fault('NOT_STARTED','First run: feedback.mjs start --dir PATH --skill NAME --task DESCRIPTION'); throw e; }
}
async function timeline(dir, data) {
  const handle = await open(join(dir,JSONL),'a',0o600);
  try { await handle.write(JSON.stringify({at:now(),...data})+'\n'); await handle.sync(); }
  finally { await handle.close(); }
}
async function events(dir) {
  const content = await readFile(join(dir,JSONL),'utf8').catch(e=>e.code==='ENOENT'?'':Promise.reject(e));
  return content.split('\n').filter(Boolean).map(row=>JSON.parse(row));
}
async function captureGit(cwd, excludePath) {
  const git = async (...args) => (await execFileAsync('git',args,{cwd,encoding:'utf8',timeout:4500,maxBuffer:6*1024*1024})).stdout;
  try {
    const root = (await git('rev-parse','--show-toplevel')).trim();
    const head = (await git('rev-parse','HEAD')).trim();
    const own=excludePath?relative(root,excludePath).replaceAll('\\','/')+'/':null;
    const statusAll = (await git('status','--porcelain=v1','--untracked-files=all')).split('\n').filter(line=>{const file=line.slice(3).replaceAll('\\','/');return !(own&&file.startsWith(own))&&!file.startsWith('.taphound/feedback/')&&!file.startsWith('.taphound/build/');}).join('\n');
    const status=statusAll.slice(0,20000);
    let sourceSnapshotComplete=statusAll.length<=20000;
    const unstaged = await git('diff','--binary','--no-ext-diff');
    const staged = await git('diff','--cached','--binary','--no-ext-diff');
    // Plain git status only identifies new files, not changed bytes. Hash small
    // untracked source files too, so edits to a new Kotlin/test file invalidate gates.
    const untracked=[];
    const untrackedPaths=status.split('\n').filter(x=>x.startsWith('?? '));
    if(untrackedPaths.length>200)sourceSnapshotComplete=false;
    let untrackedBytes=0;
    for(const line of untrackedPaths.slice(0,200)){
      const raw=line.slice(3);if(raw.startsWith('\"')) {sourceSnapshotComplete=false;untracked.push({path:raw,hash:'quoted-path-unverified'});continue;}
      const path=resolve(root,raw);
      try {const st=await stat(path);if(st.isFile()&&st.size<=2*1024*1024&&untrackedBytes+st.size<=8*1024*1024){untrackedBytes+=st.size;untracked.push({path:raw,hash:sha(await readFile(path))});}
        else {sourceSnapshotComplete=false;untracked.push({path:raw,size:st.size,mtimeMs:st.mtimeMs,hash:'large-or-nonfile'});}
      }catch{sourceSnapshotComplete=false;untracked.push({path:raw,hash:'unavailable'});}
    }
    return {root,head,status,diffSha256:sha(unstaged),stagedDiffSha256:sha(staged),untrackedContentSha256:sha(JSON.stringify(untracked)),sourceSnapshotComplete,capturedAt:now()};
  } catch { return {available:false,capturedAt:now()}; }
}

/** Snapshot execution oracles: command text alone is insufficient for a shell script. */
function invokedScriptPaths(command) {
  const ext = /\.(?:sh|bash|zsh|mjs|cjs|js|ts|py|rb|kts)$/i;
  const shell = /^(?:bash|sh|zsh|python3?|node|ruby)$/i;
  const result = [];
  for (let i=0; i<command.length; i++) {
    const arg = command[i];
    if (arg.startsWith('-') || /^[A-Za-z_][\w]*=/.test(arg)) continue;
    if (ext.test(arg) || /^\.\/?(?:gradlew|mvnw|[^/\s]+\.sh)$/.test(arg)) result.push(arg);
    else if (i>0 && shell.test(basename(command[i-1])) && !arg.startsWith('-')) result.push(arg);
  }
  return [...new Set(result)];
}
async function snapshotOracles(attempt, command, extraFiles=[]) {
  const candidates=[...new Set([...invokedScriptPaths(command),...extraFiles])];
  const snapshots=[];
  await mkdir(join(attempt,'oracles'),{recursive:true});
  for(const entry of candidates) {
    const file=resolve(entry);
    let bytes,info;
    try { info=await stat(file); if(!info.isFile() || info.size>MAX_ORACLE_BYTES) throw new Error('not a regular file or larger than 512 KiB'); bytes=await readFile(file); }
    catch(e) { snapshots.push({path:file,available:false,error:errText(e)});continue; }
    const saved=`oracles/${String(snapshots.length+1).padStart(3,'0')}-${basename(file).replace(/[^a-zA-Z0-9_.-]/g,'_')}`;
    await writeFile(join(attempt,saved),bytes,{flag:'wx',mode:0o600});
    snapshots.push({path:file,available:true,sha256:sha(bytes),size:bytes.length,snapshot:saved,explicit:extraFiles.some(x=>resolve(x)===file)});
  }
  const oracleSha256=sha(JSON.stringify({command,files:snapshots.map(({path,available,sha256,error})=>({path,available,sha256,error}))}));
  await atomicJson(join(attempt,'oracle-manifest.json'),{version:1,commandSha256:sha(JSON.stringify(command)),oracleSha256,files:snapshots});
  return {oracleSha256,oracleFiles:snapshots,explicitOracleCount:snapshots.filter(x=>x.explicit&&x.available).length};
}
async function commandBytes(executable,args,{timeoutMs=EVIDENCE_TIMEOUT_MS,maxBuffer=8*1024*1024}={}) {
  const result=await execFileAsync(executable,args,{timeout:timeoutMs,maxBuffer,encoding:'buffer'});
  return Buffer.isBuffer(result.stdout)?result.stdout:Buffer.from(result.stdout);
}
async function writeCaptured(path, bytes) { await writeFile(path,bytes,{flag:'wx',mode:0o600});return basename(path); }
/** Device evidence is best-effort and never changes the tested command's exit code. */
async function deviceEvidence(serial,packageName,out,phase) {
  if (!serial || !packageName) return {status:'notRequested'};
  const evidence={phase,serial,packageName};
  try { evidence.screenshot=await writeCaptured(join(out,`${phase}-screenshot.png`),await commandBytes(process.env.ADB||'adb',['-s',serial,'exec-out','screencap','-p'])); }
  catch(e) { evidence.screenshotError=errText(e); }
  const remote=`/sdcard/taphound-feedback-${randomUUID()}.xml`;
  try {
    await commandBytes(process.env.ADB||'adb',['-s',serial,'shell','uiautomator','dump',remote]);
    evidence.hierarchy=await writeCaptured(join(out,`${phase}-hierarchy.xml`),await commandBytes(process.env.ADB||'adb',['-s',serial,'exec-out','cat',remote]));
  } catch(e) { evidence.hierarchyError=errText(e); }
  finally { await commandBytes(process.env.ADB||'adb',['-s',serial,'shell','rm','-f',remote],{timeoutMs:3000}).catch(()=>{}); }
  try { evidence.activity=(await commandBytes(process.env.ADB||'adb',['-s',serial,'shell','dumpsys','activity','activities'],{maxBuffer:1024*1024})).toString('utf8').split('\n').filter(x=>/mResumedActivity|topResumedActivity/.test(x)).slice(0,3); }
  catch(e) { evidence.activityError=errText(e); }
  evidence.status=evidence.screenshot && evidence.hierarchy?'complete':'partial';
  return evidence;
}
async function devicePackageIdentity(serial,packageName,apkPath,attempt) {
  const identity={serial:serial??null,packageName:packageName??null,at:now(),apk:null,installed:null,agreement:'unverified'};
  if(apkPath) {
    try { const file=resolve(apkPath);const info=await stat(file);if(!info.isFile()||info.size>300*1024*1024) throw new Error('APK must be a regular file no larger than 300 MiB');const bytes=await readFile(file);identity.apk={path:file,sha256:sha(bytes),bytes:bytes.length}; }
    catch(e) { identity.apk={path:resolve(apkPath),error:errText(e)}; }
  }
  if(serial && packageName) {
    try {
      const paths=(await commandBytes(process.env.ADB||'adb',['-s',serial,'shell','pm','path',packageName])).toString('utf8').trim().split(/\r?\n/).filter(x=>x.startsWith('package:')).map(x=>x.slice(8));
      const dumpsys=(await commandBytes(process.env.ADB||'adb',['-s',serial,'shell','dumpsys','package',packageName],{maxBuffer:3*1024*1024})).toString('utf8');
      const versionName=dumpsys.match(/\bversionName=([^\s]+)/)?.[1];
      const versionCode=dumpsys.match(/\bversionCode=(\d+)/)?.[1];
      identity.installed={apkPaths:paths,versionName:versionName??null,versionCode:versionCode??null};
      if(paths.length===1 && identity.apk?.sha256) {
        try { const raw=(await commandBytes(process.env.ADB||'adb',['-s',serial,'shell','sha256sum',paths[0]],{timeoutMs:5500})).toString('utf8');const digest=raw.match(/\b[a-fA-F0-9]{64}\b/)?.[0]?.toLowerCase();if(digest){identity.installed.sha256=digest;identity.agreement=digest===identity.apk.sha256?'matched':'mismatched';} }
        catch(e) {identity.installed.hashError=errText(e);}
      }
    } catch(e) {identity.installed={error:errText(e)};}
  }
  await atomicJson(join(attempt,'apk-identity.json'),identity);
  return identity;
}
/** Keep ADB logcat within the execution interval, without clearing device buffers. */
async function startExecLogcat(serial,out) {
  if(!serial) return null;
  const lines=[];let size=0,truncated=false,error;
  let child;
  try { child=spawn(process.env.ADB||'adb',['-s',serial,'logcat','-v','threadtime'],{stdio:['ignore','pipe','pipe'],env:process.env}); }
  catch(e) { return {stop:async()=>({status:'unavailable',error:errText(e)})}; }
  child.stdout.on('data',chunk=>{ if(size>=MAX_LOG_BYTES){truncated=true;return;}const data=Buffer.from(chunk);if(size+data.length>MAX_LOG_BYTES){lines.push(data.subarray(0,MAX_LOG_BYTES-size));size=MAX_LOG_BYTES;truncated=true;}else{lines.push(data);size+=data.length;} });
  child.stderr.on('data',chunk=>{error=(error??'')+String(chunk).slice(0,512);});
  child.on('error',e=>{error=errText(e)});
  child.on('close',(code,signal)=>{if(code!==0&&code!==null&&signal!=='SIGTERM')error=error??`logcat exited with code ${code}`;});
  // Short bounded startup grace; no logcat -c, no destructive buffer changes.
  await new Promise(r=>setTimeout(r,200));
  return {stop:async()=>{
    if(child.exitCode===null && !child.killed) child.kill('SIGTERM');
    await Promise.race([new Promise(resolveClose=>child.once('close',resolveClose)),new Promise(r=>setTimeout(r,1500))]);
    if(child.exitCode===null && !child.killed) child.kill('SIGKILL');
    if(size>0) await writeCaptured(join(out,'logcat.txt'),Buffer.concat(lines));
    const result={status:error?'unavailable':size?'captured':'unavailable',bytes:size,truncated,...(error?{error:error.slice(0,1000)}:{})};
    await atomicJson(join(out,'logcat-meta.json'),result);return result;
  }};
}
async function snapshotPatch(attempt) {
  try {const {stdout}=await execFileAsync('git',['diff','--binary','HEAD'],{cwd:process.cwd(),encoding:'utf8',timeout:5500,maxBuffer:1024*1024});
    await writeFile(join(attempt,'changes.patch'),stdout,{flag:'wx',mode:0o600});return {path:'changes.patch',sha256:sha(stdout)};
  }catch(e){return {error:errText(e)};}
}

async function takeLog(dir) { return await events(dir); }
async function loadAttempts(dir) {
  const folder = join(dir,'attempts');
  const names = (await readdir(folder).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e))).filter(n=>/^\d{3,}$/.test(n)).sort();
  return Promise.all(names.map(async name=>({name,...await readJson(join(folder,name,'attempt.json')).catch(()=>({status:'interrupted',type:'unknown'}))})));
}
function mdEsc(value) { return String(value??'').replaceAll('|','\\|').replaceAll('\n',' ').slice(0,500); }
async function summary(dir) {
  const manifest = await loaded(dir);
  const runs = await loadAttempts(dir);
  const ev = await takeLog(dir);
  const gateState=await readGates(dir);
  const impact=await readJson(join(dir,'impact','plan.json')).catch(()=>undefined);
  const oracle=await readJson(join(dir,'oracle','current.json')).catch(()=>undefined);
  const report = [
    '# TapHound local feedback',
    '',
    `- Skill: ${manifest.skill}`,
    `- Task: ${manifest.task}`,
    `- Started: ${manifest.createdAt}`,
    `- Final verdict: **${manifest.final?.status ?? 'OPEN'}**`,
    `- Latest automated attempt: **${runs.at(-1)?.status ?? 'none'}**`,
    `- Total attempts: **${runs.length}**`,
    `- Bound device: **${manifest.deviceBinding?.serial??'not bound'}**`,
    `- Intermediate failures: **${runs.filter(x=>x.status!=='passed').length}**`,
    '',
    '## Every attempt (not only the latest)',
    '',
    '| # | Type | Backend | Status | Classification | Exit | Oracle hash | Evidence | APK |',
    '|---|---|---|---|---|---:|---|---|---|',
    ...runs.map(r=>`| ${mdEsc(r.name)} | ${mdEsc(r.type)} | ${mdEsc(r.backend??'?')} | ${mdEsc(r.status)} | ${mdEsc(r.classification??'?')} | ${mdEsc(r.exitCode??'?')} | ${mdEsc((r.oracleSha256??r.planSha256??r.commandSha256??'').slice(0,12))} | ${mdEsc(r.deviceEvidence??'notRequested')} | ${mdEsc(r.apkAgreement??'unverified')} |`),
    '',
    '## v3.6 completion gates and oracle provenance',
    '',
    `- Oracle review: ${oracle?.sha256??'NOT_RECORDED'} (versioned evidence; no routine user approval)`,
    '',
    ...['target','existing-tests','regression'].map(k=>`- ${k}: **${gateState[k]?.status??'NOT_RUN'}** ${gateState[k]?.summary??''}`),
    `- Planned existing tests: ${impact?.existingTests?.length??'unknown'}`,
    `- Planned regression scenarios: ${impact?.scenarios?.length??'unknown'}`,
    `- Blocking risks: ${impact?.risks?.filter(r=>r.blocking)?.length??'unknown'}`,
    '',
    '## Events and self-repairs',
    '',
    ...ev.map(e=>`- ${e.at} **${e.type??'event'}**: ${e.summary??e.attempt??''}${e.details?` — ${e.details}`:''}`),
    '',
    '## Review checks',
    '',
    '- Inspect each attempt’s `evidence/field-result.json` (or `result.json`), screenshots, hierarchy, and Logcat artifacts.',
    '- Compare `oracle-manifest.json` and file snapshots: identical command strings do not establish identical tests.',
    '- Check `apk-identity.json` for installed package and APK digests; unverified does not mean matched.',
    '- A `reproduction-confirmed` claim needs a linked failed attempt and an evidence file; incorrect or unrelated failures do not qualify.',
    '- `changes.patch` includes tracked changes, not all ignored/untracked source files. Do not treat it as a complete repository snapshot.',
    '- Compare every failure with its subsequent retry; check whether the test oracle changed.',
    '- Confirm that app changes, backend switches, and instrumentation were recorded in the timeline.',
    '- A runner exit code alone cannot establish that a reported bug was reproduced; validate the failure identity.',
    '- This archive is local only. **Review/redact secrets, personal data, logs, plans and screenshots before sharing.**',
    '',
    ...(manifest.final?.summary ? ['## Agent final analysis','',manifest.final.summary,''] : [])
  ];
  await atomicJson(join(dir,'index.json'),{schemaVersion:1,final:manifest.final??null,attempts:runs.map(({name,type,status,classification,exitCode,backend,planSha256,commandSha256,oracleSha256,deviceEvidence,apkAgreement})=>({name,type,status,classification,exitCode,backend,planSha256,commandSha256,oracleSha256,deviceEvidence,apkAgreement})),events:ev.length,deviceBinding:manifest.deviceBinding??null,gates:gateState,impact:impact?{target:impact.target,scenarios:impact.scenarios,existingTests:impact.existingTests,risks:impact.risks}:null});
  await writeFile(join(dir,'summary.md'),report.join('\n')+'\n', {mode:0o600});
}
const crcTable = Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);return c>>>0;});
function crc32(bytes) { let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0; }
function dosDate(t) { const d=new Date(t);const year=Math.max(1980,Math.min(2107,d.getFullYear()));return {date:((year-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate(),time:(d.getHours()<<11)|(d.getMinutes()<<5)|Math.floor(d.getSeconds()/2)}; }
async function listFiles(dir, relativeDir='') {
  const entries=await readdir(join(dir,relativeDir),{withFileTypes:true});let files=[];
  for(const entry of entries){
    const rel=join(relativeDir,entry.name);
    if(entry.isSymbolicLink()) continue;
    if(entry.isDirectory()) files.push(...await listFiles(dir,rel));
    else if(entry.isFile() && !['feedback.zip'].includes(entry.name) && !entry.name.includes('.tmp')) files.push(rel);
  }
  return files;
}
async function zipFeedback(dir) {
  // Mandatory records always win over bulk logcat/screenshot material.
  // An archive with missing core metadata is never reported as complete.
  const paths=(await listFiles(dir)).filter(name=>!['zip-omissions.txt','zip-manifest.json'].includes(name));
  const candidates=await Promise.all(paths.map(async path=>({path,size:(await stat(join(dir,path))).size})));
  // Reserve space for the pack report, and keep the original evidence locally.
  const policy=selectForArchive(candidates,{maxFile:MAX_FILE_BYTES,maxTotal:MAX_ZIP_BYTES-128*1024});
  const omissions=policy.omitted.map(e=>`${e.path} (${e.reason}, ${e.size} bytes)`);
  await writeFile(join(dir,'zip-omissions.txt'),omissions.length
    ? `Excluded from feedback.zip; files remain on disk:\n${omissions.join('\n')}\n`
    : 'No files omitted from feedback.zip.\n',{mode:0o600});
  const required=['manifest.json','summary.md','timeline.jsonl','index.json'];
  const criticalMissing=[...new Set([...policy.criticalOmitted,...required.filter(name=>!policy.included.some(e=>e.path===name))])];
  await writeFile(join(dir,'zip-manifest.json'),JSON.stringify({version:1,createdAt:now(),status:criticalMissing.length?'incomplete':'complete',selection:'critical-first',included:policy.included.map(e=>e.path),omitted:policy.omitted,criticalMissing,uncompressedBytes:policy.bytes},null,2)+'\n',{mode:0o600});
  const files=[...policy.included.map(x=>x.path),'zip-omissions.txt','zip-manifest.json'].sort();
  const local=[],central=[];let offset=0;
  for(const rel of files){
    const path=join(dir,rel);assertInside(dir,path);
    const st=await stat(path);const data=await readFile(path);
    const compressed=deflateRawSync(data,{level:6});const name=Buffer.from(rel.split(sep).join('/'),'utf8');
    const dt=dosDate(st.mtime);const crc=crc32(data);
    const l=Buffer.alloc(30);l.writeUInt32LE(0x04034b50,0);l.writeUInt16LE(20,4);l.writeUInt16LE(0x0800,6);l.writeUInt16LE(8,8);l.writeUInt16LE(dt.time,10);l.writeUInt16LE(dt.date,12);l.writeUInt32LE(crc,14);l.writeUInt32LE(compressed.length,18);l.writeUInt32LE(data.length,22);l.writeUInt16LE(name.length,26);
    local.push(l,name,compressed);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x0800,8);c.writeUInt16LE(8,10);c.writeUInt16LE(dt.time,12);c.writeUInt16LE(dt.date,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);
    central.push(c,name);offset+=l.length+name.length+compressed.length;
  }
  const directory=Buffer.concat(central);const e=Buffer.alloc(22);
  const count=central.length/2;if(count>65535)throw fault('ZIP_TOO_LARGE','Too many files');
  e.writeUInt32LE(0x06054b50,0);e.writeUInt16LE(count,8);e.writeUInt16LE(count,10);e.writeUInt32LE(directory.length,12);e.writeUInt32LE(offset,16);
  const tmp=join(dir,`.feedback.${randomUUID()}.tmp`);await writeFile(tmp,Buffer.concat([...local,directory,e]),{mode:0o600});await rename(tmp,join(dir,'feedback.zip'));
  if(criticalMissing.length)throw fault('FEEDBACK_CORE_OMITTED',`Archive incomplete: mandatory evidence did not fit: ${criticalMissing.join(', ')}. Full evidence stays on disk.`);
}
async function refresh(dir) { await summary(dir); await zipFeedback(dir); }
async function start(o) {
  const skill=o.flags.skill,task=o.flags.task;
  if(!['tap-check','tap-fix','taphound-verify-change','taphound-bug-fix'].includes(skill)||!task)throw fault('USAGE','start requires --skill tap-check|tap-fix --task DESCRIPTION');
  await mkdir(o.dir,{recursive:true});await mkdir(join(o.dir,'attempts'),{recursive:true});await mkdir(join(o.dir,'attachments'),{recursive:true});
  const manifest={schemaVersion:1,skill,task,createdAt:now(),runId:randomUUID(),...(o.flags.device?{deviceBinding:{serial:o.flags.device,selectionMode:'explicit',boundAt:now()}}:{})};
  await writeFile(join(o.dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600}).catch(e=>{if(e.code==='EEXIST')throw fault('ALREADY_STARTED','Feedback already exists; use a new --dir per case/run');throw e;});
  await timeline(o.dir,{type:'start',summary:task});await refresh(o.dir);
  return {status:'started',dir:o.dir,zip:join(o.dir,'feedback.zip')};
}
async function event(o) {
  await loaded(o.dir);
  if(!TYPES.has(o.flags.type)||!o.flags.summary)throw fault('USAGE','event requires --type observation|diagnosis|code-change|plan-changed|assertion-changed|backend-changed|reproduction-confirmed|retry|environment|instrumentation|risk|note and --summary TEXT');
  if(o.flags.type==='reproduction-confirmed') {
    if(!/^\d{3,}$/.test(o.flags.attempt??'')||!o.flags.evidence) throw fault('REPRO_EVIDENCE_REQUIRED','reproduction-confirmed requires --attempt NNN --evidence attempts/NNN/<file>');
    const r=await readJson(join(o.dir,'attempts',o.flags.attempt,'attempt.json'));
    if(r.status!=='failed'||r.exitCode===126||r.exitCode===127||r.spawnError) throw fault('INVALID_REPRO','Reproduction evidence must point to a failed application/test attempt, not a command launch error');
    const source=resolve(o.dir,o.flags.evidence);assertInside(o.dir,source);
    try { assertInside(join(o.dir,'attempts',o.flags.attempt),source); if(!(await stat(source)).isFile()) throw Error('not a file'); }
    catch { throw fault('REPRO_EVIDENCE_REQUIRED','Evidence must be a file in the specified failed attempt'); }
    await timeline(o.dir,{type:o.flags.type,summary:o.flags.summary,attempt:o.flags.attempt,evidence:relative(o.dir,source),...(o.flags.details?{details:o.flags.details}:{})});
  } else await timeline(o.dir,{type:o.flags.type,summary:o.flags.summary,...(o.flags.details?{details:o.flags.details}:{})});
  await refresh(o.dir);
  return {status:'recorded',zip:join(o.dir,'feedback.zip')};
}
async function attach(o) {
  await loaded(o.dir);
  const file=o.flags.file;if(!file)throw fault('USAGE','attach requires --file PATH [--label NAME]');
  const source=resolve(file);const info=await stat(source);if(!info.isFile()||info.size>MAX_FILE_BYTES)throw fault('ATTACHMENT_INVALID','Attachment not a regular file or too large');
  const out=join(o.dir,'attachments',`${Date.now()}-${randomUUID().slice(0,8)}-${basename(file).replace(/[^\w.\-]/g,'_')}`);
  await copyFile(source,out);await timeline(o.dir,{type:'attachment',summary:o.flags.label??basename(file),path:relative(o.dir,out)});await refresh(o.dir);
  return {status:'attached',path:out,zip:join(o.dir,'feedback.zip')};
}
/** Do not confuse a detached tool's successful launch with task completion.
 * Only recognize explicit structured status metadata; arbitrary stdout remains opaque.
 */
export function structuredCommandLifecycle(text) {
  let parsed;
  try {parsed=JSON.parse(text.trim());}catch{return null;}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return null;
  const state=parsed.state??parsed.status;
  const terminal=['completed','complete','finished','succeeded','success','passed','failed','error','cancelled'];
  const pending=['running','pending','queued','started','in_progress','in-progress','submitted'];
  const normalized=typeof state==='string'?state.toLowerCase():null;
  const reportedExit=parsed.exit_code??parsed.exitCode;
  if(pending.includes(normalized)||((parsed.task_id||parsed.job_id)&&!terminal.includes(normalized)))return {complete:false,state:normalized??'detached',reportedExitCode:reportedExit??null};
  if(terminal.includes(normalized)&&['failed','error','cancelled'].includes(normalized))return {complete:true,state:normalized,reportedExitCode:reportedExit??null,failed:true};
  if(terminal.includes(normalized)&&reportedExit!==undefined&&reportedExit!==null&&reportedExit!==0)return {complete:true,state:normalized,reportedExitCode:reportedExit,failed:true};
  return terminal.includes(normalized)?{complete:true,state:normalized,reportedExitCode:reportedExit??null}:null;
}
async function commandRun(o) {
  const manifest=await loaded(o.dir);if(manifest.final)throw fault('ALREADY_FINISHED','This feedback run has a final status; create another run');
  const type=o.command==='run'?'device':'command';
  const inputPlan=type==='device'?JSON.parse(await readFile(resolve(o.flags.plan),'utf8')):undefined;
  const selected=o.flags.device??inputPlan?.device??manifest.deviceBinding?.serial;
  if(inputPlan?.device && selected!==inputPlan.device)throw fault('DEVICE_CONFLICT','Plan device differs from the fixed verification device');
  if(manifest.deviceBinding && selected && manifest.deviceBinding.serial!==selected)throw fault('DEVICE_CONFLICT','This feedback case is already bound to a different device');
  if(type==='device'&&o.flags['require-logcat'])throw fault('USAGE','For journal run, declare source-derived logChecks in the frozen plan; --require-logcat is only for exec');
  const raw=o.command==='exec'?o.positional:[];
  // Direct ADB calls and arbitrary shell/Gradle commands are not trustworthy without a serial.
  const deviceLike=type==='device'||o.flags.device||o.flags.package||raw.some(x=>/^(adb|.*\/adb)$/.test(x)||/connected.*AndroidTest/i.test(x));
  if(deviceLike&&!selected&&type!=='device')throw fault('DEVICE_REQUIRED','Choose a device explicitly with --device SERIAL or start --device SERIAL. Never select another device implicitly');
  if(raw.some(x=>/connected(?:\w*)AndroidTest/i.test(x)))throw fault('UNSCOPED_INSTRUMENTATION','Gradle connectedAndroidTest may run on multiple devices. Use an explicitly scoped adb -s SERIAL shell am instrument invocation or isolated Gradle device configuration');
  const declaredSerials=raw.flatMap((word,i)=> word==='-s'&&raw[i+1]?[raw[i+1]]:/^(?:SERIAL|ANDROID_SERIAL|TAPHOUND_DEVICE_SERIAL)=(.*)$/.test(word)?[word.split('=').slice(1).join('=')]:[]);
  if(selected&&declaredSerials.some(x=>x!==selected))throw fault('DEVICE_CONFLICT','External command references a serial different from the bound device');
  if(selected&&!manifest.deviceBinding) {
    manifest.deviceBinding={serial:selected,selectionMode:o.flags.device?'explicit':'plan',boundAt:now()};
    await atomicJson(join(o.dir,'manifest.json'),manifest);
    await timeline(o.dir,{type:'device-binding',summary:`Locked verification to ${selected}`});
  }
  if(type==='device'&&!o.flags.plan)throw fault('USAGE','run requires --plan PATH');
  if(type==='command'&&!o.positional.length)throw fault('USAGE','exec requires -- COMMAND [ARGS...]');
  const attemptRoot=join(o.dir,'attempts');let attempt,number;
  for(let i=1;i<=9999;i++){
    number=String(i).padStart(3,'0');attempt=join(attemptRoot,number);
    try{await mkdir(attempt);break;}catch(e){if(e.code!=='EEXIST')throw e;attempt=undefined;}
  }
  if(!attempt)throw fault('TOO_MANY_ATTEMPTS','Exhausted attempt ids');
  const input=type==='device'?await readFile(resolve(o.flags.plan)):undefined;
  let planSha256;
  if(input){await writeFile(join(attempt,'plan.snapshot.json'),input,{flag:'wx'});planSha256=sha(input);}
  const command=type==='device'?[process.execPath,o.flags.runner?resolve(o.flags.runner):join(SELF,'field-runner.mjs'),'run',join(attempt,'plan.snapshot.json'),'--out',join(attempt,'evidence'),...(selected?['--device',selected]:[]),...(o.flags.backend?['--backend',o.flags.backend]:[]),...(o.flags['require-crash-check']?['--require-crash-check']:[])]:o.positional;
  const commandSha256=sha(JSON.stringify(command));
  const oracle=type==='command'?await snapshotOracles(attempt,command,o.oracleFiles):await snapshotOracles(attempt,command,[]);
  const oracleSha256=type==='device'?sha(JSON.stringify({planSha256,runner:basename(command[1]),oracleFiles:oracle.oracleFiles.map(x=>({sha256:x.sha256,path:x.path}))})):oracle.oracleSha256;
  const evidenceDir=join(attempt,'evidence');await mkdir(evidenceDir,{recursive:true});
  let planPackage;
  if(input){try{planPackage=JSON.parse(input.toString('utf8')).packageName;}catch{}}
  const serial=selected || undefined;
  const packageName=o.flags.package || planPackage;
  const apk=await devicePackageIdentity(serial,packageName,o.flags.apk,attempt);
  const gitPatch=await snapshotPatch(attempt);
  const startedAt=now();const before=await captureGit(process.cwd(),o.dir);await atomicJson(join(attempt,'git-before.json'),before);
  const captureDevice=type==='command' && !!serial && !!packageName;
  if(o.flags['require-logcat']&&!captureDevice)throw fault('LOGCAT_SCOPE_REQUIRED','--require-logcat on exec requires a bound --device and --package');
  const preEvidence=captureDevice?await deviceEvidence(serial,packageName,evidenceDir,'before'):undefined;
  const logcat=captureDevice?await startExecLogcat(serial,evidenceDir):undefined;
  if(number!=='001') {
    const previous=String(Number(number)-1).padStart(3,'0');
    const previousGit=await readJson(join(attemptRoot,previous,'git-after.json')).catch(()=>undefined);
    if(previousGit?.diffSha256 && before.diffSha256 && (previousGit.diffSha256!==before.diffSha256 || previousGit.stagedDiffSha256!==before.stagedDiffSha256 || previousGit.head!==before.head || previousGit.status!==before.status)) {
      await timeline(o.dir,{type:'workspace-changed-between-attempts',summary:`Git workspace differed before attempt ${number}; review git snapshots for what changed`,attempt:number});
    }
  }

  await timeline(o.dir,{type:'attempt-started',attempt:number,summary:type==='device'?`Device run; planSHA=${planSha256}`:`Command run; label=${o.flags.label??''}`,command:command.map((arg,i)=>i===0?basename(arg):arg).slice(0,50)});
  let stdout='',stderr='',code=1,spawnError;
  let executionEnv={...process.env,TAPHOUND_EVIDENCE_DIR:evidenceDir};
  let isolation='notRequested';
  if(type==='command'&&serial){
    // PATH guard covers adb invoked by custom shell scripts, including unqualified adb.
    // It cannot intercept absolute ADB paths or independently managed Gradle devices.
    const binary=process.env.ADB||'adb';
    try {
      const {stdout:pathOut}=await execFileAsync('which',[binary],{timeout:2000});
      const guardDir=join(attempt,'bin');await mkdir(guardDir,{recursive:true});
      const helper=join(SELF,'device-guard.mjs');
      const wrapper=join(guardDir,'adb');
      await writeFile(wrapper,`#!/bin/sh\nexec "${process.execPath.replaceAll('\"','\\\"')}" "${helper.replaceAll('\"','\\\"')}" "$@"\n`,{mode:0o700});
      await chmod(wrapper,0o700);
      executionEnv={...executionEnv,TAPHOUND_REAL_ADB:pathOut.trim(),TAPHOUND_DEVICE_SERIAL:serial,ANDROID_SERIAL:serial,SERIAL:serial,ADB:wrapper,PATH:`${guardDir}:${process.env.PATH??''}`};
      isolation='path-guarded-not-sandboxed';
    }catch(e){executionEnv={...executionEnv,TAPHOUND_DEVICE_SERIAL:serial,ANDROID_SERIAL:serial,SERIAL:serial};isolation='unverified-adb-guard-unavailable';}
  }
  try {
    const child=spawn(command[0],command.slice(1),{cwd:process.cwd(),env:executionEnv,stdio:['ignore','pipe','pipe'],shell:false});
    child.stdout.on('data',chunk=>{if(stdout.length<MAX_OUTPUT_BYTES)stdout+=chunk.toString().slice(0,MAX_OUTPUT_BYTES-stdout.length);});
    child.stderr.on('data',chunk=>{if(stderr.length<MAX_OUTPUT_BYTES)stderr+=chunk.toString().slice(0,MAX_OUTPUT_BYTES-stderr.length);});
    code=await new Promise(resolveClose=>{child.on('error',e=>{spawnError=errText(e);resolveClose(127);});child.on('close',x=>resolveClose(x??1));});
  } catch(e){spawnError=errText(e);}
  const logcatResult=await logcat?.stop();
  const postEvidence=captureDevice?await deviceEvidence(serial,packageName,evidenceDir,'after'):undefined;
  let crashArtifact;
  if(captureDevice){try {crashArtifact=await writeCaptured(join(evidenceDir,'crash.log'),await commandBytes(process.env.ADB||'adb',['-s',serial,'logcat','-d','-b','crash','-t','250'],{timeoutMs:5000}));}catch{}}
  await atomicJson(join(evidenceDir,'capture-manifest.json'),{before:preEvidence??null,after:postEvidence??null,logcat:logcatResult??null,crashArtifact:crashArtifact??null});
  await writeFile(join(attempt,'stdout.txt'),stdout,{flag:'wx',mode:0o600});
  await writeFile(join(attempt,'stderr.txt'),stderr,{flag:'wx',mode:0o600});
  const after=await captureGit(process.cwd(),o.dir);await atomicJson(join(attempt,'git-after.json'),after);
  let runnerResult;
  if(type==='device') {
    for(const p of ['field-result.json','result.json']){
      try {runnerResult=await readJson(join(attempt,'evidence',p));break;}catch{ /* stdout fallback */ }
    }
    if(!runnerResult){try{runnerResult=JSON.parse(stdout.trim());}catch{/* error status below */}}
  }
  const commandLifecycle=type==='command'?structuredCommandLifecycle(stdout):null;
  let status=type==='device'?(runnerResult?.status??'error'):(code===0?'passed':'failed');
  if(status==='passed'&&code!==0)status='failed';
  if(type==='command'&&status==='passed'&&commandLifecycle?.complete===false){status='inconclusive';code=4;}
  if(type==='command'&&status==='passed'&&commandLifecycle?.failed){status='failed';code=1;}
  if(type==='command' && status==='passed' && o.flags['require-logcat'] && (logcatResult?.status!=='captured'||logcatResult?.truncated||logcatResult?.error)){status='inconclusive';code=4;}
  if(serial && runnerResult?.device && runnerResult.device!==serial){status='error';code=3;spawnError=`Runner used ${runnerResult.device}, expected bound device ${serial}`;}
  if(type==='device'&&!manifest.deviceBinding&&runnerResult?.device){
    manifest.deviceBinding={serial:runnerResult.device,selectionMode:'uniquelyDiscovered',boundAt:now()};
    await atomicJson(join(o.dir,'manifest.json'),manifest);
    await timeline(o.dir,{type:'device-binding',summary:`Auto-selected only available device: ${runnerResult.device}`});
  }
  const classification=commandLifecycle?.complete===false?'ASYNC_NOT_COMPLETED':spawnError||code===126||code===127?'INFRA_ERROR':status==='passed'?'PASS':status==='inconclusive'?(o.flags['require-logcat']?'LOGCAT_EVIDENCE_UNAVAILABLE':'INCONCLUSIVE'):status==='error'?'ENVIRONMENT_ERROR':/TapHound device guard/.test(stderr)?'DEVICE_GUARD_ERROR':/syntax error|command not found|declare: -A|No such file or directory/i.test(stderr)?'SCRIPT_ERROR':runnerResult?.failure?'APP_OR_ASSERTION_FAILURE':'UNCLASSIFIED_FAILURE';
  const oracleFilesAfter=type==='command'?await Promise.all(oracle.oracleFiles.filter(x=>x.available).map(async x=>{try{return {path:x.path,sha256:sha(await readFile(x.path))};}catch{return {path:x.path,sha256:null};}})):[];
  const oracleChangedDuringRun=oracleFilesAfter.some(x=>oracle.oracleFiles.find(y=>y.path===x.path)?.sha256!==x.sha256);
  const deviceEvidenceStatus=captureDevice?(preEvidence?.status==='complete'&&postEvidence?.status==='complete'&&logcatResult?.status==='captured'?'complete':'partial'):(type==='device'?'runner-managed':'notRequested');
  const detail={schemaVersion:3,type,status,device:serial??runnerResult?.device??null,deviceIsolation:isolation,classification,explicitOracleCount:oracle.explicitOracleCount,oracleChangedDuringRun,startedAt,finishedAt:now(),exitCode:code,command:command.map((arg,i)=>i===0?basename(arg):arg),commandSha256,oracleSha256,oracleFiles:oracle.oracleFiles.map(({path,sha256,available})=>({path,sha256,available})),deviceEvidence:deviceEvidenceStatus,apkAgreement:apk.agreement,gitPatch,...(commandLifecycle?{commandLifecycle}:{}),...(planSha256?{planSha256}:{}),...(o.flags.backend?{requestedBackend:o.flags.backend}:{}),backend:runnerResult?.backend??(type==='command'?(o.flags.backend?`${o.flags.backend} (declared)`:'external-command (unverified)'):'unknown'),...(runnerResult?.probes?{probes:runnerResult.probes}:{}),...(runnerResult?.failure?{failure:runnerResult.failure}:{}),...(spawnError?{spawnError}:{})};
  await writeFile(join(attempt,'attempt.json'),JSON.stringify(detail,null,2)+'\n',{flag:'wx'});
  await timeline(o.dir,{type:'attempt-finished',attempt:number,summary:`${status} (exit ${code})`,...(detail.failure?{details:detail.failure.code??errText(detail.failure)}:{})});
  await refresh(o.dir);
  return {status,attempt:number,exitCode:code,...(detail.failure?{failure:detail.failure}:{}),evidenceDir:join(attempt,'evidence'),zip:join(o.dir,'feedback.zip')};
}
async function recordImpactPlan(o) {
  await loaded(o.dir);
  if(!o.flags.file)throw fault('USAGE','impact requires --file impact-plan.json');
  const result=await saveImpact(o.dir,o.flags.file,await captureGit(process.cwd(),o.dir));
  await timeline(o.dir,{type:'impact-changed',summary:`Impact plan sha256=${result.sha256}; required scenarios=${result.requiredScenarios.join(',')}; required tests=${result.requiredTests.join(',')}`});
  await refresh(o.dir);
  return {status:'recorded',...result,zip:join(o.dir,'feedback.zip')};
}
async function recordOracleReview(o) {
  await loaded(o.dir);
  if(!o.flags.file)throw fault('USAGE','oracle requires --file oracle-review.json');
  const result=await saveOracleReview(o.dir,o.flags.file);
  await timeline(o.dir,{type:'oracle-review',summary:`Oracle review sha256=${result.sha256}; expectations=${result.expectations}; uncertain=${result.uncertain.join(',')}; blocking=${result.blocking.join(',')}`});
  await refresh(o.dir);
  return {status:'recorded',...result,zip:join(o.dir,'feedback.zip')};
}
async function recordDiscovery(o) {
  await loaded(o.dir);
  const git=await captureGit(process.cwd(),o.dir);
  const plan=await readJson(join(o.dir,'impact','plan.json')).catch(()=>undefined);
  const sources=o.sources.length?o.sources:(plan?.changedSymbols??[]).map(s=>s.file).filter(Boolean);
  const symbols=o.symbols.length?o.symbols:(plan?.changedSymbols??[]).map(s=>s.symbol).filter(Boolean);
  if(!o.flags.project)throw fault('USAGE','discover requires --project ANDROID_PROJECT; provide --source path or record impact.changedSymbols[].file');
  const result=await discoverTests(o.flags.project,sources,symbols);
  const snapshot={...result,gitFingerprint:codeFingerprint(git)};
  await mkdir(join(o.dir,'tests'),{recursive:true});
  const version=`discovery-${Date.now()}-${randomUUID().slice(0,8)}.json`;
  await atomicJson(join(o.dir,'tests',version),snapshot);
  await atomicJson(join(o.dir,'tests','discovery.json'),snapshot);
  await timeline(o.dir,{type:'test-discovery',summary:`Discovered ${result.inventory.testFiles} test files, ${result.candidateTests.length} candidate related tests; complete=${result.scanComplete}`,evidence:`tests/${version}`});
  await refresh(o.dir);
  return {status:'recorded',testFiles:result.inventory.testFiles,candidateTests:result.candidateTests.map(t=>t.path),scanComplete:result.scanComplete,zip:join(o.dir,'feedback.zip')};
}
async function recordVerificationGate(o) {
  const m=await loaded(o.dir);if(m.final)throw fault('ALREADY_FINISHED','Cannot change gates after finish');
  const result=await recordGate(o.dir,{gate:o.flags.gate,status:o.flags.status,summary:o.flags.summary,attempts:o.attempts,scenarios:o.scenarios,tests:o.tests,reports:o.reports,evidence:o.evidence},await captureGit(process.cwd(),o.dir),m.deviceBinding?.serial);
  await timeline(o.dir,{type:'gate-recorded',gate:result.gate,summary:`${result.status}: ${o.flags.summary}`,attempts:o.attempts,scenarios:o.scenarios,tests:o.tests});
  await refresh(o.dir);
  return {status:'recorded',...result,zip:join(o.dir,'feedback.zip')};
}
async function finish(o) {
  const m=await loaded(o.dir);
  if(m.final)throw fault('ALREADY_FINISHED','Feedback already finalized; history is immutable');
  const status=o.flags.status,summaryText=o.flags.summary;
  if(!ACCEPTED.has(status)||!summaryText)throw fault('USAGE','finish requires --status PASS|FAIL|INCONCLUSIVE|BLOCKED|FIXED|NOT_REPRODUCED|FAILED and --summary TEXT');
  const attempts=await loadAttempts(o.dir);
  if(!attempts.length && !['BLOCKED','INCONCLUSIVE','NOT_REPRODUCED'].includes(status))throw fault('VERDICT_UNSUPPORTED','No attempts recorded for this verdict');
  if(status==='PASS'||status==='FIXED') {
    const oracle=await readOracleReview(o.dir).catch(error=>{if(error?.code==='ENOENT')throw fault('ORACLE_REQUIRED','Record source-backed oracle expectations before a successful finish');throw error;});
    if(oracle.review.expectations.some(e=>e.confidence==='uncertain')||oracle.review.uncertainties.some(e=>e.blocking))throw fault('ORACLE_UNRESOLVED','Unresolved essential expectations must not yield PASS/FIXED');
    if(!oracle.review.expectations.some(e=>e.scope==='target'&&e.confidence==='supported'))throw fault('ORACLE_UNSUPPORTED','No source-backed supported target expectation');
    await validateCompletion(o.dir,status,await captureGit(process.cwd(),o.dir),attempts,await events(o.dir),m.deviceBinding?.serial);
  }
  m.final={status,summary:summaryText,finishedAt:now()};await atomicJson(join(o.dir,'manifest.json'),m);
  await timeline(o.dir,{type:'finish',summary:`${status}: ${summaryText}`});await refresh(o.dir);
  return {status,attempts:attempts.length,zip:join(o.dir,'feedback.zip')};
}
async function main(){const o=parse(process.argv.slice(2));let result;
  try {
    switch(o.command){case 'start':result=await start(o);break;case 'event':result=await event(o);break;case 'run':case 'exec':result=await commandRun(o);break;case 'impact':result=await recordImpactPlan(o);break;case 'oracle':result=await recordOracleReview(o);break;case 'discover':result=await recordDiscovery(o);break;case 'gate':result=await recordVerificationGate(o);break;case 'finish':result=await finish(o);break;case 'attach':result=await attach(o);break;case 'status':await loaded(o.dir);await refresh(o.dir);result={status:'ready',dir:o.dir,zip:join(o.dir,'feedback.zip'),index:await readJson(join(o.dir,'index.json'))};break;}
  } catch(error){
    // Save even rejected completion claims for independent review: a failed
    // finish must not silently disappear from the user-facing feedback ZIP.
    if(o.command!=='start'&&['finish','gate','impact','oracle','discover','exec','run'].includes(o.command)){
      try {await loaded(o.dir);await timeline(o.dir,{type:'operation-rejected',command:o.command,summary:`${error.code??'ERROR'}: ${errText(error)}`});await refresh(o.dir);}catch{/* preserve original exception */}
    }
    throw error;
  }
  print(result);
  if(o.command==='run'||o.command==='exec')process.exitCode=result.exitCode===0?0:result.exitCode===4?4:1;
}
try{await main();}catch(e){print({status:'error',code:e.code??'FEEDBACK_ERROR',message:errText(e)});process.exitCode=2;}
