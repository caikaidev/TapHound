#!/usr/bin/env node
/**
 * TapHound Flash ADB runner — portable, no npm dependencies.
 * node flash.mjs run plan.json --device SERIAL --out DIRECTORY
 * Node.js 22+, Android platform-tools. It does NOT build/install the APK.
 * Portable field edition: limited to the Flash v1 plan vocabulary.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { validateTarget, parseUiXml, selectMatches, centerOf } from './ui-locator.mjs';

const execAsync = promisify(execFile);
const sleep = ms => new Promise(done => setTimeout(done, ms));
const fail = (code, message) => Object.assign(new Error(message), { code });
const errorText = error => error instanceof Error ? error.message : String(error);
const POLL_MS = 250;

function options(argv) {
  const [command, planFile, ...words] = argv;
  if (command !== 'run' || !planFile || planFile.startsWith('--')) throw fail('USAGE', 'Usage: flash.mjs run <plan.json> --out <directory> [--device <serial>]');
  const opts = { command, planFile: resolve(planFile) };
  for (let i = 0; i < words.length; i++) {
    const key = words[i], value = words[++i];
    if (!['--device', '--out'].includes(key) || !value) throw fail('USAGE', `Unexpected or missing option ${key}`);
    opts[key.slice(2)] = value;
  }
  if (!opts.out) throw fail('USAGE', '--out is required');
  opts.out = resolve(opts.out);
  return opts;
}

function validate(p) {
  if (!p || p.version !== 1 || typeof p.packageName !== 'string' || !/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(p.packageName)) throw fail('PLAN_INVALID','Invalid Flash v1 plan');
  if (!Array.isArray(p.steps) || !p.steps.length || p.steps.length > 50) throw fail('PLAN_INVALID', 'Plan must have 1..50 steps');
  if (p.launchMode!==undefined && !['launcher','activity'].includes(p.launchMode)) throw fail('PLAN_INVALID','launchMode must be launcher or activity');
  if (!p.steps.some(s => s.action === 'expect' || s.action === 'expectActivity')) throw fail('PLAN_INVALID', 'Plan requires at least one observable assertion');
  for (const [i,s] of p.steps.entries()) {
    if (!s || !['tap','type','back','wait','expect','expectActivity'].includes(s.action)) throw fail('PLAN_INVALID', `Invalid step ${i}`);
    if (s.action === 'tap' || s.action === 'expect') {
      const t = s.target;
      try { validateTarget(t); } catch (error) { throw fail('PLAN_INVALID', `Invalid target at step ${i}: ${error.message}`); }
    }
    if (s.action === 'type' && (typeof s.text !== 'string' || !/^[\x20-\x7e]+$/.test(s.text))) throw fail('PLAN_INVALID', `Step ${i} ADB typing supports printable ASCII only`);
    if (s.action === 'expectActivity' && (typeof s.activity !== 'string' || !s.activity)) throw fail('PLAN_INVALID', `Invalid Activity at step ${i}`);
    if (s.action === 'wait' && (!Number.isInteger(s.ms) || s.ms < 1 || s.ms > 30000)) throw fail('PLAN_INVALID', `Invalid wait at step ${i}`);
    if (s.timeoutMs !== undefined && (!Number.isInteger(s.timeoutMs) || s.timeoutMs < 1)) throw fail('PLAN_INVALID', `Invalid timeout at step ${i}`);
    if (s.absent !== undefined && (s.action !== 'expect' || typeof s.absent !== 'boolean')) throw fail('PLAN_INVALID', `Invalid absent flag at step ${i}`);
    if (s.newSinceAction !== undefined && (s.action !== 'expect' || s.absent === true || typeof s.newSinceAction !== 'boolean')) throw fail('PLAN_INVALID', `Invalid freshness flag at step ${i}`);
    if (s.newSinceAction === true && !p.steps.slice(0,i).some(x=>['tap','type','back'].includes(x.action))) throw fail('PLAN_INVALID', `newSinceAction requires a preceding mutation`);
  }
  return p;
}

async function adb(args, timeoutMs=10000, binary=false) {
  try {
    const { stdout } = await execAsync(process.env.ADB || 'adb', args, {
      timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
      encoding: binary ? 'buffer' : 'utf8', windowsHide: true
    });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw fail('ADB_MISSING', 'adb command not found');
    throw fail('ADB_FAILED', `adb ${args.join(' ')}: ${errorText(error).slice(0,350)}`);
  }
}

async function detectSerial(requested) {
  const list = await adb(['devices'],4000);
  const devices = list.split(/\r?\n/).filter(s => /\sdevice\s*$/.test(s)).map(s => s.trim().split(/\s+/)[0]);
  if (requested && !devices.includes(requested)) throw fail('DEVICE_UNAVAILABLE', `Device ${requested} is not connected`);
  if (!requested && devices.length !== 1) throw fail('DEVICE_UNAVAILABLE', `Exactly one online device is required, found ${devices.length}; pass --device`);
  return requested ?? devices[0];
}

function unique(nodes,target,pkg) {
  const selected=selectMatches(nodes,target,pkg);
  if (selected.length > 1) throw fail('TARGET_AMBIGUOUS', `Target ${JSON.stringify(target)} matched ${selected.length} elements`);
  return selected[0];
}
function location(node) { const {x,y}=centerOf(node); return [x,y]; }

function activityName(name,pkg) { return name?.startsWith('.') ? pkg+name : name; }
async function currentActivity(serial,pkg) {
  const output=await adb(['-s',serial,'shell','dumpsys','activity','activities'],6000);
  const line=output.split(/\r?\n/).find(l => /topResumedActivity|mResumedActivity/.test(l)) ?? '';
  const match=/([\w.$]+)\/([\w.$]+)/.exec(line);
  if(!match) throw fail('ACTIVITY_UNAVAILABLE','Could not determine current foreground Activity');
  if(match[1] !== pkg) throw fail('LEFT_APP',`App ${pkg} is no longer in foreground (${match[1]})`);
  return activityName(match[2],pkg);
}
async function alive(serial,pkg) {
  try { return (await adb(['-s',serial,'shell','pidof',pkg],5000)).trim() !== ''; }
  catch { return false; }
}
async function hierarchy(serial) {
  const remote=`/sdcard/taphound-field-${randomUUID().slice(0,10)}.xml`;
  try {
    const dumped=await adb(['-s',serial,'shell','uiautomator','dump',remote],13000);
    if (/ERROR:|null root node|FAILED/i.test(dumped)) throw fail('UI_DUMP_FAILED',dumped.trim());
    const xml=await adb(['-s',serial,'exec-out','cat',remote],6000);
    if (!xml.includes('<hierarchy') && !xml.includes('<node')) throw fail('UI_DUMP_FAILED','ADB returned an empty UI hierarchy');
    return xml;
  } finally {
    await adb(['-s',serial,'shell','rm','-f',remote],3000).catch(()=>undefined);
  }
}
async function snapshot(serial,pkg) { const xml=await hierarchy(serial);return {xml,nodes:parseUiXml(xml,pkg)}; }
async function waitTarget(serial,pkg,target,absent,timeoutMs) {
  const deadline=Date.now()+timeoutMs;let lastError;
  for (;;) {
    if(!await alive(serial,pkg)) throw fail('APP_CRASHED',`App ${pkg} process terminated`);
    try {
      const snap=await snapshot(serial,pkg);const hit=unique(snap.nodes,target,pkg);
      if (absent ? !hit : !!hit) return hit;
    } catch(error) {
      if(error.code==='TARGET_AMBIGUOUS'||error.code==='APP_CRASHED') throw error;
      lastError=error;
    }
    if(Date.now()>=deadline)throw fail(absent?'EXPECT_FAILED':'TARGET_NOT_FOUND',`${JSON.stringify(target)} ${absent?'still present':'not found'}${lastError?` (${lastError.message})`:''}`);
    await sleep(Math.min(POLL_MS,deadline-Date.now()));
  }
}
async function waitActivity(serial,pkg,expect,timeoutMs) {
  const deadline=Date.now()+timeoutMs;let last='';
  for(;;){
    if(!await alive(serial,pkg)) throw fail('APP_CRASHED',`App ${pkg} process terminated`);
    try {last=await currentActivity(serial,pkg);if(last===activityName(expect,pkg))return;}
    catch(e){if(e.code==='LEFT_APP')throw e;last=e.message;}
    if(Date.now()>=deadline)throw fail('ACTIVITY_MISMATCH',`Expected ${expect}; actual ${last}`);
    await sleep(Math.min(POLL_MS,deadline-Date.now()));
  }
}
async function doStep(step,serial,plan) {
  const timeout=step.timeoutMs??plan.timeoutMs??10000;
  if(step.action==='tap') {
    const node=await waitTarget(serial,plan.packageName,step.target,false,timeout);
    const [x,y]=location(node);
    await adb(['-s',serial,'shell','input','tap',String(x),String(y)]);
  } else if(step.action==='type') {
    // Constrain to printable ASCII. Shell quoting is handled by adb command argument vector;
    // spaces use Android input's documented %s escape.
    const encoded=step.text.replaceAll(' ','%s');
    await adb(['-s',serial,'shell','input','text',encoded]);
  } else if(step.action==='back') {
    await adb(['-s',serial,'shell','input','keyevent','BACK']);
  } else if(step.action==='wait') await sleep(step.ms);
  else if(step.action==='expectActivity') await waitActivity(serial,plan.packageName,step.activity,timeout);
  else if(step.action==='expect') {
    try {await waitTarget(serial,plan.packageName,step.target,step.absent===true,timeout);}
    catch(e){if(e.code==='TARGET_NOT_FOUND')e.code='EXPECT_FAILED';throw e;}
  }
  if(!await alive(serial,plan.packageName)) throw fail('APP_CRASHED',`App process terminated during ${step.action}`);
}

async function run(opts,plan) {
  const startedAt=new Date().toISOString(),steps=[],evidence={},freshBefore=new Map();let failure;
  const serial=await detectSerial(opts.device ?? plan.device);
  await mkdir(opts.out,{recursive:true});
  try {
    const path=await adb(['-s',serial,'shell','pm','path',plan.packageName]);
    if (!path.includes('package:')) throw fail('APP_NOT_INSTALLED',`Package ${plan.packageName} is not installed`);
    await adb(['-s',serial,'shell','am','force-stop',plan.packageName]);
    let startupActivity=plan.launchMode==='launcher'?undefined:plan.activity;
    if(startupActivity){
      try {await adb(['-s',serial,'shell','am','start','-n',`${plan.packageName}/${activityName(startupActivity,plan.packageName)}`],15000);}
      catch(error){
        if(!/SecurityException|Permission Denial|not exported|not allowed to start/i.test(errorText(error)))throw error;
        // An internal/non-exported Activity is reached through the public launcher UI.
        startupActivity=undefined;
        evidence.launchFallback='launcher-after-nonexported-activity';
      }
    }
    if(!startupActivity)await adb(['-s',serial,'shell','monkey','-p',plan.packageName,'-c','android.intent.category.LAUNCHER','1'],15000);
    await waitActivity(serial,plan.packageName,startupActivity??(await currentActivity(serial,plan.packageName)),plan.launchTimeoutMs??30000);
    for(const [index,step] of plan.steps.entries()){
      const at=Date.now();
      try {
        if(['tap','type','back'].includes(step.action)){
          const follow=[];
          for(let j=index+1;j<plan.steps.length;j++){
            const f=plan.steps[j];if(['tap','type','back'].includes(f.action))break;
            if(f.action==='expect'&&f.newSinceAction===true)follow.push({index:j,target:f.target});
          }
          if(follow.length){
            const before=await snapshot(serial,plan.packageName);
            for(const item of follow){const found=selectMatches(before.nodes,item.target,plan.packageName);if(found.length>1)throw fail('TARGET_AMBIGUOUS','Freshness precondition matched multiple elements');freshBefore.set(item.index,{beforeCount:found.length,sourceAction:index});}
          }
        }
        if(step.action==='expect'&&step.newSinceAction===true){
          const proof=freshBefore.get(index);
          if(!proof)throw fail('FRESHNESS_UNVERIFIED','Missing pre-action UI observation');
          if(proof.beforeCount>0)throw fail('STALE_EXPECTATION','Expected element was already present before the preceding action');
        }
        await doStep(step,serial,plan);
        steps.push({index,action:step.action,status:'passed',...(step.newSinceAction===true?{freshness:{verifiedNotPresentBeforeAction:true,sourceAction:freshBefore.get(index)?.sourceAction}}:{}),startedAtMs:at,finishedAtMs:Date.now(),durationMs:Date.now()-at});
      }
      catch(error) { const crashed=!(await alive(serial,plan.packageName));failure={stepIndex:index,code:crashed?'APP_CRASHED':error.code??'STEP_FAILED',message:errorText(error)};steps.push({index,action:step.action,status:'failed',startedAtMs:at,finishedAtMs:Date.now(),durationMs:Date.now()-at});break; }
    }
  } catch(error) {failure={stepIndex:null,code:error.code??'EXECUTION_ERROR',message:errorText(error)};}
  try {const xml=await hierarchy(serial);await writeFile(join(opts.out,'hierarchy.xml'),xml);evidence.hierarchy=join(opts.out,'hierarchy.xml');}
  catch(error){evidence.hierarchyError=errorText(error);}
  try {const png=await adb(['-s',serial,'exec-out','screencap','-p'],10000,true);await writeFile(join(opts.out,'screenshot.png'),png);evidence.screenshot=join(opts.out,'screenshot.png');}
  catch(error){evidence.screenshotError=errorText(error);}
  try {const log=await adb(['-s',serial,'logcat','-d','-b','crash','-t','1000'],6000);await writeFile(join(opts.out,'crash.log'),log);evidence.crashLog=join(opts.out,'crash.log');}
  catch(error){evidence.crashError=errorText(error);}
  const status=failure?(failure.stepIndex===null?'error':'failed'):(evidence.screenshot?'passed':'error');
  if(status==='error'&&!failure) failure={stepIndex:null,code:'EVIDENCE_MISSING',message:evidence.screenshotError??'Screenshot missing'};
  const result={schemaVersion:1,status,backend:'adb',device:serial,startedAt,finishedAt:new Date().toISOString(),steps,evidence,...(failure?{failure}:{})};
  await writeFile(join(opts.out,'result.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}
try {
  const opts=options(process.argv.slice(2));
  const plan=validate(JSON.parse(await readFile(opts.planFile,'utf8')));
  const result=await run(opts,plan);
  console.log(JSON.stringify(result,null,2));
  if(result.status!=='passed')process.exitCode=result.status==='failed'?1:result.failure?.code==='DEVICE_UNAVAILABLE'?3:2;
} catch(error) {
  console.log(JSON.stringify({status:'error',failure:{stepIndex:null,code:error.code??'RUNNER_ERROR',message:errorText(error)}},null,2));
  process.exitCode=['PLAN_INVALID','USAGE'].includes(error.code)?2:3;
}
