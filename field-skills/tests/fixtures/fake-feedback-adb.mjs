#!/usr/bin/env node
import process from 'node:process';
const args=process.argv.slice(2);
if(args[0]!=='-s'||args[1]!=='FAKE123') process.exit(2);
const a=args.slice(2);
if(a[0]==='exec-out'&&a[1]==='screencap') process.stdout.write(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WTn23wAAAAASUVORK5CYII=','base64'));
else if(a[0]==='exec-out'&&a[1]==='cat') process.stdout.write('<hierarchy><node resource-id="app:id/chat" /></hierarchy>');
else if(a[0]==='shell'&&a[1]==='pm')process.stdout.write('package:/data/app/base.apk\n');
else if(a[0]==='shell'&&a[1]==='dumpsys'&&a[2]==='package')process.stdout.write('versionCode=42 versionName=1.0.1\n');
else if(a[0]==='shell'&&a[1]==='dumpsys')process.stdout.write('topResumedActivity: app/.Main\n');
else if(a[0]==='shell'&&a[1]==='sha256sum')process.stdout.write(`${process.env.FAKE_INSTALLED_SHA??'f'.repeat(64)}  /data/app/base.apk\n`);
else if(a[0]==='shell'&&a[1]==='pidof')process.stdout.write('4001\n');
else if(a[0]==='logcat'&&a.includes('-d')) process.stdout.write('');
else if(a[0]==='logcat'){
  process.stdout.write('11-04 17:00:01.001  4001  4001 I Wrapped/Log: session started\n');
  const timer=setInterval(()=>{},200);process.on('SIGTERM',()=>{clearInterval(timer);process.exit(0)});
}
