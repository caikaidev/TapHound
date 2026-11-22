#!/usr/bin/env node
/** Deterministic ADB UI inspection/tap helper. For exploratory use; final
 * acceptance must be executed via the feedback journal's frozen plan.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { parseUiXml, selectMatches, centerOf, validateTarget } from './ui-locator.mjs';
const execAsync=promisify(execFile);
const fail=(code,message)=>Object.assign(new Error(message),{code});
const adb=process.env.ADB||'adb';
async function exec(serial,args,timeout=12000){
  try {return (await execAsync(adb,['-s',serial,...args],{timeout,maxBuffer:16*1024*1024,encoding:'utf8'})).stdout;}
  catch(error){throw fail('ADB_FAILED',`ADB operation failed: ${error.message}`);}
}
function parse(args){
  const [action,...rest]=args;
  if(!['find','tap','expect'].includes(action))throw fail('USAGE','ui-probe.mjs find|tap|expect --device SERIAL --package APP --id|--text|--desc VALUE [--match exact|prefix|contains|regex] [--absent]');
  const opt={action};for(let i=0;i<rest.length;i++){
    const key=rest[i];if(key==='--absent'){opt.absent=true;continue;}
    if(!['--device','--package','--id','--text','--desc','--match'].includes(key))throw fail('USAGE',`Unknown option ${key}`);
    const value=rest[++i];if(!value)throw fail('USAGE',`Missing ${key}`);opt[key.slice(2)]=value;
  }
  if(!opt.device||!opt.package)throw fail('USAGE','--device SERIAL and --package APP are required');
  const target=Object.fromEntries(['id','text','desc','match'].flatMap(key=>opt[key]===undefined?[]:[[key,opt[key]]]));
  validateTarget(target);return {...opt,target};
}
async function main(){
  const opts=parse(process.argv.slice(2));
  const remote=`/data/local/tmp/taphound-probe-${randomUUID().slice(0,12)}.xml`;
  let xml;
  try {
    await exec(opts.device,['shell','uiautomator','dump',remote],20000);
    xml=await exec(opts.device,['exec-out','cat',remote]);
  }finally {await exec(opts.device,['shell','rm','-f',remote],3000).catch(()=>undefined);}
  const found=selectMatches(parseUiXml(xml,opts.package),opts.target,opts.package);
  if(found.length>1)throw fail('TARGET_AMBIGUOUS',`Found ${found.length} matches; do not guess`);
  const element=found[0];
  if(opts.action==='expect'){
    const passed=opts.absent?!element:!!element;
    const result={status:passed?'passed':'failed',device:opts.device,matchedCount:found.length,target:opts.target};
    console.log(JSON.stringify(result));if(!passed)process.exitCode=1;return;
  }
  if(!element)throw fail('TARGET_NOT_FOUND','No UI element matched the target');
  const point=centerOf(element,{requireClickable:opts.action==='tap'});
  if(opts.action==='tap')await exec(opts.device,['shell','input','tap',String(point.x),String(point.y)]);
  console.log(JSON.stringify({status:'passed',device:opts.device,action:opts.action,target:opts.target,point}));
}
try{await main()}catch(e){console.log(JSON.stringify({status:'error',code:e.code||'PROBE_ERROR',message:e.message}));process.exitCode=e.code==='USAGE'||e.code==='PLAN_INVALID'?2:1;}
