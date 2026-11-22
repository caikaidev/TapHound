#!/usr/bin/env node
/** Device-scoped ADB PATH wrapper. Parse ADB *global* options only, never
 * interpret subcommand flags (e.g. `logcat -d` is dump, not device select).
 * This is not a security sandbox; commands invoking absolute adb paths bypass it.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
const serial=process.env.TAPHOUND_DEVICE_SERIAL;
const binary=process.env.TAPHOUND_REAL_ADB;
const args=process.argv.slice(2);
function reject(message){process.stderr.write(`TapHound device guard: ${message}\n`);process.exit(96);}
if (!serial || !binary) reject('Missing bound serial or original adb binary');
if (!args.length) reject('ADB arguments missing');
const globalSafe=new Set(['devices','version','help']);
const forbiddenCommands=new Set(['start-server','kill-server','connect','disconnect','reconnect','reconnect-offline','mdns']);
let index=0, observed;
// Only ADB global options are consumed before the first command. Once a
// command begins, -d/-e/-s/-t belong to that command and must not be re-read.
while(index < args.length){
  const arg=args[index];
  if(arg==='-s'||arg.startsWith('-s')&&arg.length>2){
    if(observed!==undefined)reject('Multiple ADB device selectors');
    const value=arg==='-s'?args[index+1]:arg.slice(2);
    if(!value||value.startsWith('-'))reject('adb -s is missing serial');
    observed=value;index+=arg==='-s'?2:1;continue;
  }
  if(['-d','-e','-t','--transport-id','--one-device'].includes(arg)
      || /^--(?:transport-id|one-device)=/.test(arg) || /^-t\d/.test(arg)) reject(`Alternative device selector ${arg} is forbidden`);
  if(arg==='-H'||arg==='-P'||arg==='-L'||arg==='-a')reject(`ADB server-level flag ${arg} is forbidden`);
  if(arg==='--') {index++;break;}
  if(arg.startsWith('-'))reject(`Unexpected ADB global option ${arg}; refusing unscoped execution`);
  break;
}
const command=args[index];
if(!command)reject('ADB subcommand missing');
if(forbiddenCommands.has(command))reject(`Global ADB command ${command} is forbidden`);
if(observed!==undefined&&observed!==serial)reject(`Attempted to operate a different device; bound=${serial}, requested=${observed}`);
if(globalSafe.has(command)&&observed===undefined){
  // Only listing and pure information commands may be unscoped.
  if(command==='devices'&&args.slice(index+1).some(flag=>flag!=='-l'))reject('Unexpected devices option');
} else if(observed===undefined){args.unshift('-s',serial);}
const child=spawn(binary,args,{stdio:'inherit',env:process.env,shell:false});
child.on('error',error=>reject(`Cannot start actual adb: ${error.message}`));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>child.kill(sig));
child.on('close',(code,signal)=>{process.exitCode=code??(signal?1:0);});
