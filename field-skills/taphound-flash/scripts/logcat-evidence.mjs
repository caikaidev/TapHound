/** Android logcat evidence, independent of an application's logging wrapper/tag convention.
 *  Scope a capture to this run using an injected ADB log marker and host-side step windows.
 *  This is NOT an app log assertion library: the agent must derive predicates from source.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const execAsync = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const LINE_LIMIT = 25000;
const LINE_MAX_BYTES = 8192;
const TAG = 'TapHoundFieldProbe';
const threadtime = /^(\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.+?):\s(.*)$/;
const msg = err => err instanceof Error ? err.message : String(err);

export class LogcatObserver {
  constructor(serial, adb = process.env.ADB || 'adb') {
    this.serial = serial; this.adb = adb; this.entries = []; this.buffer = '';
    this.marker = `TH_FIELD_${randomUUID().replaceAll('-', '')}`;
    this.ready = false; this.overflow = false; this.fault = undefined;
    this.child = undefined; this.closed = false;
  }
  onLine(line) {
    if (!this.ready) {
      if (line.includes(this.marker) && line.includes(TAG)) this.ready = true;
      return;
    }
    if (line.includes(this.marker)) return;
    if (this.entries.length >= LINE_LIMIT) { this.overflow = true; return; }
    // Limit the raw evidence file size; mark truncation as incomplete evidence.
    if (Buffer.byteLength(line) > LINE_MAX_BYTES) {
      this.overflow = true;
      return;
    }
    const match = threadtime.exec(line);
    this.entries.push({
      receivedAtMs: Date.now(),
      sequence: this.entries.length,
      raw: line,
      ...(match ? {
        deviceTime: match[1], pid: Number(match[2]), tid: Number(match[3]),
        level: match[4], tag: match[5].trim(), message: match[6]
      } : { tag: undefined, message: line })
    });
  }
  async start() {
    try {
    this.child = spawn(this.adb, ['-s', this.serial, 'logcat', '-b', 'main', '-b', 'system', '-b', 'crash', '-v', 'threadtime', '-T', '1'], {
      stdio: ['ignore','pipe','pipe'], env: process.env
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      for (;;) {
        const i = this.buffer.indexOf('\n'); if (i < 0) break;
        const line = this.buffer.slice(0,i).replace(/\r$/, ''); this.buffer = this.buffer.slice(i+1);
        this.onLine(line);
      }
      if (this.buffer.length > LINE_MAX_BYTES * 2) { this.buffer = ''; this.overflow = true; }
    });
    let stderr = '';
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', x => { stderr = (stderr + x).slice(-1000); });
    this.child.on('error', error => { this.fault = msg(error); });
    this.child.on('exit', code => { if (!this.closed) this.fault = `logcat exited (${code}): ${stderr}`; });
    // Wait for spawn before writing the marker; the marker itself provides the ready fence.
    await Promise.race([
      new Promise((resolve,reject) => { this.child.once('spawn', resolve); this.child.once('error', reject); }),
      sleep(2000).then(() => { throw new Error('logcat spawn timeout'); })
    ]);
    try {
      await execAsync(this.adb, ['-s', this.serial, 'shell', 'log', '-p', 'i', '-t', TAG, this.marker], {
        timeout: 3000, maxBuffer: 1024 * 1024
      });
    } catch (error) { throw new Error(`Cannot fence logcat start: ${msg(error)}`); }
    const deadline = Date.now() + 3000;
    while (!this.ready && !this.fault && Date.now() < deadline) await sleep(30);
    if (!this.ready) throw new Error(`Logcat marker not observed; cannot prove a fresh log window (${this.fault || 'timeout'})`);
    return this;
    } catch (error) {
      this.closed = true; this.child?.kill('SIGTERM'); throw error;
    }
  }
  async wait(ms) { if (ms > 0) await sleep(ms); }
  async finish(out) {
    this.closed = true;
    this.child?.kill('SIGTERM');
    await writeFile(join(out, 'logcat.txt'), this.entries.map(x => x.raw).join('\n') + (this.entries.length ? '\n' : ''), 'utf8');
    return { path: 'logcat.txt', lines: this.entries.length, overflow: this.overflow, ...(this.fault ? { error: this.fault } : {}) };
  }
}

function matches(entry, check) {
  if (check.tag !== undefined && entry.tag !== check.tag) return false;
  if (check.tagRegex !== undefined && !new RegExp(check.tagRegex).test(entry.tag ?? '')) return false;
  if (check.messageContains !== undefined && !(entry.message ?? '').includes(check.messageContains)) return false;
  if (check.messageRegex !== undefined && !new RegExp(check.messageRegex).test(entry.message ?? '')) return false;
  if (check.rawContains !== undefined && !entry.raw.includes(check.rawContains)) return false;
  if (check.rawRegex !== undefined && !new RegExp(check.rawRegex).test(entry.raw)) return false;
  return true;
}

/** Evaluate predicates only in declared device-operation windows. Missing positive logs
 *  are INCONCLUSIVE, not automatically a product failure (builds may suppress logging).
 */
export function evaluateLogChecks(checks, steps, observer, runFinishedAtMs) {
  const results = [];
  let failing = false, inconclusive = !!observer.fault || observer.overflow;
  for (const check of checks) {
    const begin = steps[check.fromStep]?.startedAtMs;
    const end = check.toStep === undefined
      ? runFinishedAtMs
      : steps[check.toStep]?.finishedAtMs;
    if (begin === undefined || end === undefined) {
      results.push({ id:check.id, status:'notRun', message:'Reference UI step was not executed' });
      inconclusive = true; continue;
    }
    const matching = observer.entries.filter(x => x.receivedAtMs >= begin && x.receivedAtMs <= end && matches(x, check));
    const min = check.minCount ?? (check.maxCount === 0 ? 0 : 1);
    const max = check.maxCount;
    let status = 'passed', reason;
    if (max !== undefined && matching.length > max) {
      status = 'failed'; failing = true; reason = `Observed ${matching.length} matching event(s), maximum ${max}`;
    } else if (matching.length < min) {
      status = 'inconclusive'; inconclusive = true;
      reason = `Observed ${matching.length} matching event(s), required at least ${min}; logger/filter/runtime may suppress evidence`;
    }
    results.push({
      id:check.id, status, observedCount:matching.length, minCount:min,
      ...(max === undefined ? {} : { maxCount:max }), fromStep:check.fromStep,
      ...(check.toStep === undefined ? {} : { toStep:check.toStep }),
      ...(check.sourceRef === undefined ? {} : { sourceRef:check.sourceRef }),
      matchingLines:matching.slice(0,20).map(x=>({ line:x.sequence+1, sha256:createHash('sha256').update(x.raw).digest('hex') })),
      ...(reason ? {message:reason} : {})
    });
  }
  // Require recorded events in the specified order within named groups.
  for (const [index, check] of checks.entries()) {
    if (check.orderGroup === undefined || results[index]?.status !== 'passed') continue;
    const previous = checks.slice(0,index).map((candidate,k)=>({candidate, result:results[k]}))
      .filter(x => x.candidate.orderGroup === check.orderGroup && x.result?.status === 'passed');
    if (!previous.length) continue;
    const ownLine = results[index].matchingLines[0]?.line;
    const prevLine = previous.at(-1).result.matchingLines[0]?.line;
    if (ownLine !== undefined && prevLine !== undefined && ownLine <= prevLine) {
      results[index].status = 'failed';
      results[index].message = 'Expected ordered log stages, but matched evidence is out of order or identical';
      failing = true;
    }
  }
  return {
    status: failing ? 'failed' : inconclusive ? 'inconclusive' : 'passed',
    checks: results, complete: !observer.overflow && !observer.fault && observer.ready,
    ...(observer.overflow ? { warning:'Log buffer overflow: evidence incomplete' } : {}),
    ...(observer.fault ? { warning:observer.fault } : {})
  };
}
