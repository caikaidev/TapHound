#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
const args=process.argv.slice(2);
const plan=JSON.parse(readFileSync(args[1],'utf8'));
const out=args[args.indexOf('--out')+1];
const rows=[];
const variant=process.env.SIM_VARIANT || 'pass';
function emit(tag,content) {appendFileSync(process.env.FAKE_LOG_FILE,`10-30 14:00:01.000  4242  4242 I ${tag}: ${content}\n`);}
// This value is intentionally from before the run's marker and must not prove success.
for (let i=0;i<plan.steps.length;i++) {
  const now=Date.now();
  if(i===0) {
    if(variant==='pass'||variant==='reverse'||variant==='forbidden') {
      if(variant==='reverse') { emit('AppLogger','persisted key=Q9'); emit('AppLogger','start key=Q9'); }
      else { emit('Wrapped/LogProxy','start key=Q9'); emit('StorageFacade','persisted key=Q9'); }
    } else if(variant==='partial') emit('Wrapped/LogProxy','start key=Q9');
    if(variant==='forbidden') emit('Wrapped/LogProxy','error invalid state key=Q9');
  }
  rows.push({ index:i, action:plan.steps[i].action, status:'passed',startedAtMs:now,finishedAtMs:Date.now()+10 });
}
const result={status:'passed',steps:rows,evidence:{screenshot:'screenshot.png'}, backend:'adb'};
writeFileSync(join(out,'result.json'),JSON.stringify(result));
process.stdout.write(JSON.stringify(result));
