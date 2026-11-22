#!/usr/bin/env node
/** One-shot bounded ADB Logcat dump. Separate capture status from event count.
 * Never returns success on an ADB failure or an empty unreadable response.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const run=promisify(execFile);
const fail=(code,message)=>Object.assign(new Error(message),{code});
function options(argv){
  const opt={buffers:['main','system','crash']};
  for(let i=0;i<argv.length;i++){
    const k=argv[i],v=argv[i+1];
    if(!['--device','--out','--buffer'].includes(k)||!v)throw fail('USAGE',`Bad option ${k}`);
    i++;if(k==='--buffer')opt.buffers=v.split(',');else opt[k.slice(2)]=v;
  }
  if(!opt.device||!opt.out||!opt.buffers.length||opt.buffers.some(x=>!['main','system','crash','events'].includes(x)))throw fail('USAGE','logcat-dump.mjs --device SERIAL --out FILE [--buffer main,system,crash]');
  return opt;
}
async function main(){
  const opts=options(process.argv.slice(2));
  const file=resolve(opts.out);
  const args=['-s',opts.device,'logcat','-d','-v','threadtime','-t','2000',...opts.buffers.flatMap(b=>['-b',b])];
  let stdout;
  try {({stdout}=await run(process.env.ADB||'adb',args,{encoding:'utf8',timeout:12000,maxBuffer:12*1024*1024}));}
  catch(error){throw fail('LOGCAT_CAPTURE_FAILED',`Cannot read Logcat on ${opts.device}: ${error.message}`);}
  // Successful empty capture is not the same as evidence of 'no crash'.
  if(!stdout.trim())throw fail('LOGCAT_EMPTY','Logcat returned no readable lines; absence of app events is unproven');
  await mkdir(dirname(file),{recursive:true});await writeFile(file,stdout,{flag:'wx',mode:0o600});
  console.log(JSON.stringify({status:'captured',device:opts.device,path:file,bytes:Buffer.byteLength(stdout),lines:stdout.split(/\r?\n/).filter(Boolean).length}));
}
try{await main()}catch(e){console.log(JSON.stringify({status:'error',code:e.code||'LOGCAT_CAPTURE_FAILED',message:e.message}));process.exitCode=2;}
