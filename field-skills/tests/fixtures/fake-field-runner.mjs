#!/usr/bin/env node
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const args=process.argv.slice(2);
const out=args[args.indexOf('--out')+1];
const status=process.env.TAPHOUND_TEST_STATUS || 'passed';
const plan=JSON.parse(await readFile(args[1],'utf8'));
if(!out)process.exit(2);
await mkdir(out,{recursive:true});
await writeFile(join(out,'field-result.json'),JSON.stringify({schemaVersion:2,status,backend:'fake-ui',device:'sim-5554',steps:plan.steps.map((step,index)=>({index,action:step.action,status:status==='passed'?'passed':'failed'})), ...(status==='failed'?{failure:{stepIndex:0,code:'APP_CRASHED',message:'simulated crash'}}:{})})+'\n');
await writeFile(join(out,'logcat.txt'),`FAKE Log for ${status}\n`);
console.log(JSON.stringify({status,backend:'fake-ui'}));
process.exitCode=status==='passed'?0:status==='inconclusive'?4:1;
