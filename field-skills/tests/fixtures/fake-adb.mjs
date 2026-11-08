#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
const args = process.argv.slice(2);
if (args[0] === 'devices') { process.stdout.write('List of devices attached\nFAKE123\tdevice\n'); process.exit(0); }
const log = process.env.FAKE_LOG_FILE;
if (!log) { process.stderr.write('Missing FAKE_LOG_FILE'); process.exit(1); }
if (args[0] !== '-s' || args[1] !== 'FAKE123') process.exit(2);
const cmd=args.slice(2);
if (cmd[0] === 'shell' && cmd[1] === 'log') {
  const marker=cmd.at(-1);
  appendFileSync(log,`10-30 14:00:00.000  1010  1010 I TapHoundFieldProbe: ${marker}\n`);
} else if (cmd[0] === 'logcat') {
  let offset=0;
  const tick=() => {
    if(!existsSync(log))return;
    const data=readFileSync(log,'utf8');
    if (data.length > offset) { process.stdout.write(data.slice(offset)); offset=data.length; }
  };
  tick();const t=setInterval(tick,10);
  const stop=()=>{clearInterval(t);process.exit(0);};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
} else process.exit(0);
