#!/usr/bin/env node
/** TapHound portable field runner v3.6. Uses the bundled Flash ADB runner.
 *  Auto priority: mobile-mcp -> Appium -> bundled flash/ADB. Never switch after a test has begun.
 *  Node 22+; no required npm dependency (MCP protocol uses stdio JSON-RPC).
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { LogcatObserver, evaluateLogChecks } from './logcat-evidence.mjs';
import { validateTarget, selectMatches, targetXpath, parseUiXml, centerOf } from './ui-locator.mjs';
const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_APPIUM = 'http://127.0.0.1:4723';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const message = error => error instanceof Error ? error.message : String(error);
const fail = (code, explanation) => Object.assign(new Error(explanation), { code });
const ACTIONS = ['tap', 'type', 'back', 'expect', 'expectActivity', 'wait'];
const LOG_FIELDS = ['tag', 'tagRegex', 'messageContains', 'messageRegex', 'rawContains', 'rawRegex'];
const WINDOW_MS = 250;

function parseOptions(argv) {
  const [command, ...rest] = argv;
  if (!['probe', 'run'].includes(command)) throw fail('USAGE', 'Usage: field-runner.mjs probe|run <plan.json> [--out dir] [--backend auto|mobile-mcp|appium|adb] [--device serial] [--require-crash-check]');
  const opts = { command, backend: 'auto', out: undefined, device: undefined, requireCrashCheck: false };
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    if (word === '--require-crash-check') { opts.requireCrashCheck = true; continue; }
    if (['--out', '--backend', '--device'].includes(word)) {
      const val = rest[++i];
      if (!val || val.startsWith('--')) throw fail('USAGE', `Missing ${word} value`);
      opts[word.slice(2)] = val;
    } else if (opts.planPath === undefined && !word.startsWith('--')) opts.planPath = resolve(word);
    else throw fail('USAGE', `Unknown argument: ${word}`);
  }
  if (!opts.planPath) throw fail('USAGE', 'Plan file required');
  if (!['auto', 'mobile-mcp', 'appium', 'adb'].includes(opts.backend)) throw fail('USAGE', 'Unknown backend');
  if (command === 'run' && !opts.out) throw fail('USAGE', '--out is required');
  if (opts.out) opts.out = resolve(opts.out);
  return opts;
}
function validatePlan(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1 || !Array.isArray(data.steps) || !data.steps.length || data.steps.length > 50) throw fail('PLAN_INVALID', 'Expected flash plan version 1 with 1..50 steps');
  if (typeof data.packageName !== 'string' || !/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(data.packageName)) throw fail('PLAN_INVALID', 'Invalid packageName');
  if (data.activity !== undefined && (typeof data.activity !== 'string' || !data.activity)) throw fail('PLAN_INVALID', 'Invalid activity');
  if (data.launchMode !== undefined && !['launcher','activity'].includes(data.launchMode)) throw fail('PLAN_INVALID','launchMode must be launcher or activity');
  for (const [i, s] of data.steps.entries()) {
    if (!s || !ACTIONS.includes(s.action)) throw fail('PLAN_INVALID', `Invalid action at step ${i}`);
    if (['tap', 'expect'].includes(s.action)) {
      const t = s.target;
      try { validateTarget(t); } catch (error) { throw fail('PLAN_INVALID', `Invalid target at step ${i}: ${message(error)}`); }
    }
    if (s.action === 'type' && (typeof s.text !== 'string' || !s.text)) throw fail('PLAN_INVALID', `Invalid type text at step ${i}`);
    if (s.action === 'expectActivity' && (typeof s.activity !== 'string' || !s.activity)) throw fail('PLAN_INVALID', `Invalid activity at step ${i}`);
    if (s.action === 'wait' && (!Number.isInteger(s.ms) || s.ms < 1)) throw fail('PLAN_INVALID', `Invalid wait duration at step ${i}`);
    if (s.timeoutMs !== undefined && (!Number.isInteger(s.timeoutMs) || s.timeoutMs < 1)) throw fail('PLAN_INVALID', `Invalid timeout at step ${i}`);
    if (s.absent !== undefined && (s.action !== 'expect' || typeof s.absent !== 'boolean')) throw fail('PLAN_INVALID', `Invalid absent flag at step ${i}`);
    if (s.newSinceAction !== undefined && (s.action !== 'expect' || s.absent===true || typeof s.newSinceAction !== 'boolean')) throw fail('PLAN_INVALID', `newSinceAction only applies to positive expect at step ${i}`);
    if (s.newSinceAction === true && !data.steps.slice(0,i).some(x=>['tap','type','back'].includes(x.action))) throw fail('PLAN_INVALID', `newSinceAction requires a preceding UI mutation at step ${i}`);
  }
  if (data.verificationMode !== undefined && !['smoke', 'full'].includes(data.verificationMode)) throw fail('PLAN_INVALID', 'verificationMode must be smoke or full');
  if (data.logChecks !== undefined) {
    if (!Array.isArray(data.logChecks) || !data.logChecks.length || data.logChecks.length > 30) throw fail('PLAN_INVALID', 'logChecks must contain 1..30 checks');
    const ids = new Set();
    for (const check of data.logChecks) {
      if (!check || typeof check !== 'object' || Array.isArray(check) || typeof check.id !== 'string' || !/^[a-z][\w-]{0,63}$/.test(check.id) || ids.has(check.id)) throw fail('PLAN_INVALID', 'logChecks need distinct ids');
      ids.add(check.id);
      if (!Number.isInteger(check.fromStep) || check.fromStep < 0 || check.fromStep >= data.steps.length) throw fail('PLAN_INVALID', `logCheck ${check.id} has invalid fromStep`);
      if (check.toStep !== undefined && (!Number.isInteger(check.toStep) || check.toStep < check.fromStep || check.toStep >= data.steps.length)) throw fail('PLAN_INVALID', `logCheck ${check.id} has invalid toStep`);
      if (!LOG_FIELDS.some(k=>check[k] !== undefined)) throw fail('PLAN_INVALID', `logCheck ${check.id} needs an application-derived matching predicate`);
      for (const field of LOG_FIELDS) if (check[field] !== undefined) {
        if (typeof check[field] !== 'string' || !check[field] || check[field].length > 512) throw fail('PLAN_INVALID', `Invalid ${field} in ${check.id}`);
        if (field.endsWith('Regex')) { try { new RegExp(check[field]); } catch { throw fail('PLAN_INVALID', `Invalid regex in ${check.id}`); } }
      }
      if (check.minCount !== undefined && (!Number.isInteger(check.minCount) || check.minCount < 0)) throw fail('PLAN_INVALID', `Invalid minCount in ${check.id}`);
      if (check.maxCount !== undefined && (!Number.isInteger(check.maxCount) || check.maxCount < 0 || (check.minCount !== undefined && check.maxCount < check.minCount))) throw fail('PLAN_INVALID', `Invalid maxCount in ${check.id}`);
      if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 0 || check.timeoutMs > 20000)) throw fail('PLAN_INVALID', `Invalid log timeout in ${check.id}`);
      if (check.orderGroup !== undefined && (typeof check.orderGroup !== 'string' || !check.orderGroup)) throw fail('PLAN_INVALID', `Invalid orderGroup in ${check.id}`);
      if (check.sourceRef !== undefined && (typeof check.sourceRef !== 'string' || !check.sourceRef)) throw fail('PLAN_INVALID', `Invalid sourceRef in ${check.id}`);
    }
  }
  if(data.scenarioIds!==undefined){
    if(!Array.isArray(data.scenarioIds)||data.scenarioIds.some(id=>typeof id!=='string'||!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(id))||new Set(data.scenarioIds).size!==data.scenarioIds.length)throw fail('PLAN_INVALID','scenarioIds must be unique identifiers');
    if(!Array.isArray(data.scenarioChecks)||data.scenarioChecks.length!==data.scenarioIds.length)throw fail('PLAN_INVALID','Each scenarioId needs an independent scenarioChecks assertion mapping');
    const usedIndices=new Set();
    for(const check of data.scenarioChecks){
      if(!data.scenarioIds.includes(check?.id)||!Array.isArray(check.assertionSteps)||!check.assertionSteps.length)throw fail('PLAN_INVALID','scenarioChecks needs id and nonempty assertionSteps[]');
      for(const idx of check.assertionSteps){
        if(!Number.isInteger(idx)||idx<0||idx>=data.steps.length||!['expect','expectActivity'].includes(data.steps[idx].action))throw fail('PLAN_INVALID','scenarioChecks can reference only assertion step indices');
        if(usedIndices.has(idx))throw fail('PLAN_INVALID','Independent regression scenarios must not share the same sole assertion step');
        usedIndices.add(idx);
      }
    }
  }
  // A test with only tapping is a smoke action, not an acceptance test.
  if (!data.steps.some(x => x.action === 'expect' || x.action === 'expectActivity')) throw fail('PLAN_INVALID', 'At least one independent outcome assertion is required');
  return data;
}
function adbCommand(args, timeoutMs = 5000) {
  return execFileAsync(process.env.ADB || 'adb', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
}
async function adbDeviceList() {
  try {const {stdout}=await adbCommand(['devices'],2000);return stdout.split(/\r?\n/).filter(l=>/\sdevice\s*$/.test(l)).map(l=>l.trim().split(/\s+/)[0]);}
  catch {return [];}
}
async function adbAvailable(serial) {
  try {
    const devices = await adbDeviceList();
    if (serial && !devices.includes(serial)) return undefined;
    return serial || (devices.length === 1 ? devices[0] : undefined);
  } catch { return undefined; }
}
async function adbCrash(serial, out) {
  if (!serial) return;
  try {
    const { stdout } = await adbCommand(['-s', serial, 'logcat', '-d', '-b', 'crash', '-t', '1000'], 5000);
    await writeFile(join(out, 'crash.log'), stdout);
  } catch { /* non-fatal; the result records whether crash monitoring was available */ }
}
async function adbAlive(serial, packageName) {
  try {
    const { stdout } = await adbCommand(['-s', serial, 'shell', 'pidof', packageName], 4000);
    return stdout.trim().length > 0;
  } catch { return undefined; }
}
async function adbActivity(serial, packageName) {
  const { stdout } = await adbCommand(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities'], 5000);
  const line = stdout.split(/\r?\n/).find(x => /topResumedActivity|mResumedActivity/.test(x)) ?? '';
  const match = line.match(/([A-Za-z][\w.]*)\/([\w.$]+)/);
  if (!match) throw fail('ACTIVITY_UNAVAILABLE', `Cannot determine foreground activity: ${line}`);
  const full = match[2].startsWith('.') ? match[1] + match[2] : match[2];
  if (match[1] !== packageName) throw fail('LEFT_APP', `Expected ${packageName}, found ${match[1]}`);
  return full;
}
function expectedActivity(activity, packageName) { return activity.startsWith('.') ? packageName + activity : activity; }

class McpClient {
  constructor(command) { this.command = command; this.child = undefined; this.pending = new Map(); this.nextId = 1; this.buffer = ''; this.closed = false; }
  async connect() {
    this.child = spawn(this.command, [], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, MOBILEMCP_DISABLE_TELEMETRY: '1' } });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', s => {
      this.buffer += s;
      for (;;) {
        const idx = this.buffer.indexOf('\n'); if (idx < 0) break;
        const line = this.buffer.slice(0, idx).trim(); this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const data = JSON.parse(line), p = this.pending.get(data.id);
          if (p) { this.pending.delete(data.id); data.error ? p.reject(fail('MCP_ERROR', JSON.stringify(data.error))) : p.resolve(data.result); }
        } catch { /* ignore invalid provider output, pending call times out */ }
      }
    });
    this.child.on('error', e => this.rejectPending(e));
    this.child.on('exit', code => this.rejectPending(fail('MCP_DISCONNECTED', `MCP server exited: ${code}`)));
    await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'taphound-field-runner', version: '0.1.0' } }, 4000);
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  rejectPending(error) { for (const p of this.pending.values()) p.reject(error); this.pending.clear(); }
  async request(method, params = {}, timeout = 8000) {
    const id = this.nextId++;
    const work = new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(fail('MCP_TIMEOUT', `${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve: x => { clearTimeout(t); resolve(x); }, reject: x => { clearTimeout(t); reject(x); } });
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return work;
  }
  async tool(name, args = {}) {
    const r = await this.request('tools/call', { name, arguments: args }, 20000);
    const text = (r.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
    if (r.isError) throw fail('MCP_TOOL_FAILED', `${name}: ${text}`);
    return text;
  }
  async close() { if (this.closed) return; this.closed = true; this.rejectPending(fail('MCP_CLOSED', 'Client closed')); if (this.child) { this.child.stdin.end(); this.child.kill(); } }
}
function parseMcpElements(raw) {
  const prefix = 'Found these elements on screen: ';
  if (!raw.startsWith(prefix)) throw fail('UI_UNAVAILABLE', 'Unexpected Mobile MCP elements response');
  const list = JSON.parse(raw.slice(prefix.length));
  if (!Array.isArray(list)) throw fail('UI_UNAVAILABLE', 'Mobile MCP did not provide an element list');
  return list.map(e => {
    const r = e.coordinates ?? {};
    if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) throw fail('UI_UNAVAILABLE', 'Mobile MCP element lacks valid coordinates');
    const bounds=[r.x,r.y,r.x+r.width,r.y+r.height];
    const node={id:e.identifier,text:e.text ?? e.value,desc:e.label ?? e.name, enabled:true,clickable:true,bounds,raw:e};
    const point=centerOf(node);
    return {...node,...point};
  });
}
function locateMcp(elements, target) { return selectMatches(elements, target); }
async function openMobile(opts, plan, adbSerial) {
  const client = new McpClient(process.env.TAPHOUND_MCP_COMMAND || 'mcp-server-mobile');
  try {
    await client.connect();
    const listed = JSON.parse(await client.tool('mobile_list_available_devices'));
    const android = (listed.devices ?? []).filter(d => d.platform?.toLowerCase() === 'android' && d.state !== 'offline');
    const chosen = opts.device ? android.find(x => x.id === opts.device) : android.length === 1 ? android[0] : undefined;
    if (!chosen) throw fail('MCP_DEVICE_UNAVAILABLE', 'Mobile MCP requires one Android device; use --device if several are connected');
    const serial = chosen.id;
    const crashSerial = adbSerial ?? await adbAvailable(serial);
    if ((opts.requireCrashCheck || plan.logChecks?.length) && !crashSerial) throw fail('CAPABILITY_MISSING', 'Mobile MCP requires auxiliary ADB for Crash/Logcat evidence');
    if (plan.steps.some(x => x.action === 'expectActivity') && !crashSerial) throw fail('CAPABILITY_MISSING', 'Mobile MCP requires auxiliary ADB for Activity assertions');
    const screenSize = await client.tool('mobile_get_screen_size', { device: serial });
    if (!/^Screen size is [1-9]\d*x[1-9]\d* pixels$/.test(screenSize)) throw fail('UI_UNAVAILABLE', 'Mobile MCP screen-size probe failed');
    return {
      kind: 'mobile-mcp', device: serial, crashSerial, close: () => client.close(),
      start: async () => { await client.tool('mobile_terminate_app', { device: serial, packageName: plan.packageName }).catch(() => undefined); await client.tool('mobile_launch_app', { device: serial, packageName: plan.packageName }); },
      elements: async () => parseMcpElements(await client.tool('mobile_list_elements_on_screen', { device: serial })),
      tap: async element => client.tool('mobile_click_on_screen_at_coordinates', { device: serial, x: element.x, y: element.y }),
      type: async text => client.tool('mobile_type_keys', { device: serial, text, submit: false }),
      back: async () => client.tool('mobile_press_button', { device: serial, button: 'BACK' }),
      activity: async () => adbActivity(crashSerial, plan.packageName),
      screenshot: async out => { await client.tool('mobile_save_screenshot', { device: serial, saveTo: out }); },
      evidence: async out => writeFile(out, await client.tool('mobile_list_elements_on_screen', { device: serial }))
    };
  } catch (e) { await client.close(); throw e; }
}
function appiumUrl() {
  const raw = process.env.TAPHOUND_APPIUM_URL || DEFAULT_APPIUM;
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password) throw fail('APPIUM_URL_INVALID', 'Appium URL must use local HTTP');
  return url.href.replace(/\/$/, '');
}
async function appiumRequest(base, method, path, body, ms = 7000) {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(ms), ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) throw fail('APPIUM_ERROR', `${method} ${path}: ${payload.value?.message ?? response.status}`);
  return payload.value;
}
async function openAppium(opts, plan, adbSerial) {
  const udid=opts.device??adbSerial;
  if(!udid)throw fail('DEVICE_REQUIRED','Appium requires an explicit or uniquely discovered Android device; refusing an arbitrary session');
  const url = appiumUrl();
  const status = await appiumRequest(url, 'GET', '/status');
  if (status?.ready === false) throw fail('APPIUM_NOT_READY', 'Appium server is not ready');
  if ((opts.requireCrashCheck || plan.logChecks?.length) && !adbSerial) throw fail('CAPABILITY_MISSING', 'ADB is required for Appium Crash/Logcat evidence');
  const caps = { platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:deviceName': udid, 'appium:appPackage': plan.packageName, 'appium:noReset': true, 'appium:newCommandTimeout': 120 };
  caps['appium:udid'] = udid;
  if (plan.activity && plan.launchMode!=='launcher') caps['appium:appActivity'] = plan.activity;
  let created;
  try { created = await appiumRequest(url, 'POST', '/session', { capabilities: { alwaysMatch: caps, firstMatch: [{}] } }, 30000); }
  catch(error){
    if(!caps['appium:appActivity']||!/SecurityException|Permission Denial|not exported|not allowed to start/i.test(message(error)))throw error;
    // Retry only the launcher entry and keep the explicitly bound UDID.
    delete caps['appium:appActivity'];
    created=await appiumRequest(url,'POST','/session',{capabilities:{alwaysMatch:caps,firstMatch:[{}]}},30000);
  }
  const sessionId = created?.sessionId;
  if (!sessionId) throw fail('APPIUM_ERROR', 'Appium returned no sessionId');
  const reported=created?.capabilities?.['appium:udid']??created?.capabilities?.udid;
  if(reported!==udid){
    await appiumRequest(url,'DELETE',`/session/${encodeURIComponent(sessionId)}`,undefined,3500).catch(()=>undefined);
    throw fail('DEVICE_IDENTITY_UNVERIFIED',reported===undefined?'Appium session did not attest its device UDID':`Appium returned device ${reported}; expected ${udid}`);
  }
  const api = (method, path, body) => appiumRequest(url, method, `/session/${encodeURIComponent(sessionId)}${path}`, body, 20000);
  return {
    kind: 'appium', device: udid, crashSerial: adbSerial,
    close: () => api('DELETE', '').catch(() => undefined),
    start: async () => { await api('POST', '/appium/app/terminate', { appId: plan.packageName }).catch(() => undefined); await api('POST', '/appium/app/activate', { appId: plan.packageName }); },
    elements: async () => [],
    find: async target => {
      const xpath=targetXpath(target,plan.packageName);
      if (xpath !== null) {
        const all = await api('POST','/elements',{using:'xpath',value:xpath});
        return (all ?? []).map(e=>({id:e['element-6066-11e4-a52e-4f735466cecf'] || e.ELEMENT}));
      }
      // Regex cannot be expressed in XPath 1.0. Read the live hierarchy and
      // select deterministically; tap by W3C pointer action at the clipped center.
      const source=await api('GET','/source');
      const nodes=parseUiXml(typeof source==='string'?source:String(source),plan.packageName,{appium:true});
      return selectMatches(nodes,target,plan.packageName).map(e=>({point:centerOf(e,{requireClickable:false})}));
    },
    tap: async element => element.point
      ? api('POST','/actions',{actions:[{type:'pointer',id:'taphound-touch',parameters:{pointerType:'touch'},actions:[
          {type:'pointerMove',duration:0,origin:'viewport',x:element.point.x,y:element.point.y},
          {type:'pointerDown',button:0},{type:'pause',duration:60},{type:'pointerUp',button:0}]}]})
      : api('POST',`/element/${encodeURIComponent(element.id)}/click`,{}),
    type: async text => { const el = await api('GET', '/element/active'); const id = el?.['element-6066-11e4-a52e-4f735466cecf'] || el?.ELEMENT; if (!id) throw fail('NO_FOCUSED_INPUT', 'No active Appium element'); await api('POST', `/element/${encodeURIComponent(id)}/value`, { text }); },
    back: async () => api('POST', '/back', {}),
    activity: async () => api('GET', '/appium/device/current_activity'),
    screenshot: async out => { const value = await api('GET', '/screenshot'); await writeFile(out, Buffer.from(value, 'base64')); },
    evidence: async out => { const value = await api('GET', '/source'); await writeFile(out, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
  };
}
async function choose(opts, plan) {
  if(opts.device&&plan.device&&opts.device!==plan.device)throw fail('DEVICE_CONFLICT','Plan device differs from explicitly requested device');
  const specified=opts.device??plan.device;
  const online=await adbDeviceList();
  if(!specified&&online.length>1)throw fail('DEVICE_REQUIRED',`Multiple connected Android devices (${online.join(', ')}); specify --device SERIAL before any test`);
  if(specified&&online.length>0&&!online.includes(specified)){
    // Mobile MCP might use a distinct identifier, but a declared ADB identity must not silently map to another device.
    // Keep probing MCP exact ID; ADB/Appium will still enforce the bound value.
  }
  const probed = [];
  const order = opts.backend === 'auto' ? ['mobile-mcp','appium','adb'] : [opts.backend];
  const adbSerial = await adbAvailable(specified);
  for (const choice of order) {
    try {
      if (choice === 'mobile-mcp') {
        const runner = await openMobile({ ...opts, device: opts.device ?? plan.device }, plan, adbSerial);
        return { runner, probed };
      }
      if (choice === 'appium') {
        const runner = await openAppium({ ...opts, device: opts.device ?? plan.device }, plan, adbSerial);
        return { runner, probed };
      }
      if (choice === 'adb') {
        if (!adbSerial) throw fail('ADB_UNAVAILABLE', 'ADB not found or no uniquely selected online device');
        if (plan.steps.some(x => x.action === 'type' && /[^\x20-\x7e]/.test(x.text))) throw fail('CAPABILITY_MISSING', 'Flash ADB input supports printable ASCII only');
        return { runner: { kind: 'adb', device: adbSerial, crashSerial: adbSerial }, probed };
      }
    } catch (error) {
      probed.push({ backend: choice, unavailable: message(error) });
      if (opts.backend !== 'auto') break;
    }
  }
  throw fail('NO_BACKEND', 'No backend with required capabilities. ' + probed.map(x => `${x.backend}: ${x.unavailable}`).join('; '));
}
function matchesTarget(elements, target) { return selectMatches(elements, target); }
async function find(runner, target) { return runner.find ? runner.find(target) : matchesTarget(await runner.elements(), target); }
async function pollFind(runner, target, absent, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = await find(runner, target);
    if (found.length > 1) throw fail('TARGET_AMBIGUOUS', `Target ${JSON.stringify(target)} matched ${found.length} elements`);
    if ((found.length === 0) === absent) return found[0];
    if (Date.now() >= until) throw fail(absent ? 'EXPECT_FAILED' : 'TARGET_NOT_FOUND', `Target ${JSON.stringify(target)} ${absent ? 'still exists' : 'not found'}`);
    await sleep(Math.min(WINDOW_MS, until - Date.now()));
  }
}
async function runUi(runner, opts, plan, probed) {
  const out = opts.out;
  await mkdir(out, { recursive: true });
  const startedAt = new Date().toISOString();
  const steps = [];
  const freshBefore = new Map(); // expectation step -> observed before most recent mutation
  let failure;
  try {
    await runner.start();
    for (const [index, step] of plan.steps.entries()) {
      const started = Date.now();
      try {
        const timeoutMs = step.timeoutMs ?? plan.timeoutMs ?? 10000;
        if (['tap','type','back'].includes(step.action)) {
          const upcoming=[];
          for(let j=index+1;j<plan.steps.length;j++){
            const following=plan.steps[j];
            if(['tap','type','back'].includes(following.action))break;
            if(following.action==='expect'&&following.newSinceAction===true)upcoming.push({index:j,target:following.target});
          }
          for(const item of upcoming){
            const found=await find(runner,item.target);
            if(found.length>1)throw fail('TARGET_AMBIGUOUS',`Freshness precondition ${item.index} matched multiple elements`);
            freshBefore.set(item.index,{beforeCount:found.length,sourceAction:index});
          }
        }
        if (step.action === 'tap') await runner.tap(await pollFind(runner, step.target, false, timeoutMs));
        else if (step.action === 'type') await runner.type(step.text);
        else if (step.action === 'back') await runner.back();
        else if (step.action === 'wait') await sleep(step.ms);
        else if (step.action === 'expect') {
          if(step.newSinceAction===true){
            const proof=freshBefore.get(index);
            if(!proof)throw fail('FRESHNESS_UNVERIFIED','No before-action observation for newSinceAction expectation');
            if(proof.beforeCount>0)throw fail('STALE_EXPECTATION','Expected element already matched before the preceding action; presence alone cannot prove a new result');
          }
          try { await pollFind(runner, step.target, step.absent === true, timeoutMs); }
          catch (e) { if (e.code === 'TARGET_NOT_FOUND') e.code = 'EXPECT_FAILED'; throw e; }
        }
        else if (step.action === 'expectActivity') {
          const deadline = Date.now() + timeoutMs;
          let actual;
          for (;;) { actual = await runner.activity(); if (expectedActivity(actual, plan.packageName) === expectedActivity(step.activity, plan.packageName)) break; if (Date.now() >= deadline) throw fail('ACTIVITY_MISMATCH', `Expected ${step.activity}, observed ${actual}`); await sleep(Math.min(WINDOW_MS, deadline - Date.now())); }
        }
        const alive = runner.crashSerial && await adbAlive(runner.crashSerial, plan.packageName);
        if (alive === false) throw fail('APP_CRASHED', 'App process is not running after step');
        steps.push({ index, action: step.action, status: 'passed', ...(step.newSinceAction===true?{freshness:{verifiedNotPresentBeforeAction:true,sourceAction:freshBefore.get(index)?.sourceAction}}:{}), startedAtMs:started, finishedAtMs:Date.now(), durationMs: Date.now() - started });
      } catch (error) {
        // If a tool failed because the app died mid-command, preserve the meaningful crash verdict.
        const alive = runner.crashSerial && await adbAlive(runner.crashSerial, plan.packageName);
        const code = alive === false ? 'APP_CRASHED' : (error.code || 'STEP_FAILED');
        failure = { stepIndex: index, code, message: alive === false ? `App process terminated during ${step.action}` : message(error) };
        steps.push({ index, action: step.action, status: 'failed', failure, startedAtMs:started, finishedAtMs:Date.now(), durationMs: Date.now() - started });
        break;
      }
    }
  } catch (error) { failure = { stepIndex: null, code: error.code || 'EXECUTION_ERROR', message: message(error) }; }
  const evidence = {};
  try { await runner.screenshot(join(out,'screenshot.png')); evidence.screenshot = 'screenshot.png'; } catch (error) { evidence.screenshotError = message(error); }
  try { await runner.evidence(join(out,'hierarchy.txt')); evidence.hierarchy = 'hierarchy.txt'; } catch (error) { evidence.hierarchyError = message(error); }
  await adbCrash(runner.crashSerial, out);
  if (runner.crashSerial) evidence.crashLog = 'crash.log';
  const status = failure
    ? (failure.stepIndex === null ? 'error' : 'failed')
    : (evidence.screenshot ? 'passed' : 'error');
  const result = {
    schemaVersion: 1, status, backend: runner.kind,
    device: runner.device, startedAt, finishedAt: new Date().toISOString(),
    plan: opts.planPath, probes: probed, steps, evidence,
    ...(failure ? { failure } : (!evidence.screenshot ? { failure: { stepIndex: null, code: 'EVIDENCE_MISSING', message: evidence.screenshotError || 'Screenshot capture unavailable' } } : {}))
  };
  await writeFile(join(out,'result.json'), JSON.stringify(result,null,2)+'\n');
  return result;
}
async function runAdb(opts, plan, probed, serial) {
  const flash = process.env.TAPHOUND_FLASH_SCRIPT || join(HERE, 'flash.mjs');
  await mkdir(opts.out, { recursive: true });
  const child = spawn(process.execPath, [flash, 'run', opts.planPath, '--device', serial, '--out', opts.out], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', x => stdout += x);
  child.stderr.setEncoding('utf8').on('data', x => stderr += x);
  const exit = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done); });
  let underlying;
  try { underlying = JSON.parse(stdout); } catch { throw fail('FLASH_OUTPUT_INVALID', `Flash did not return JSON (exit ${exit}): ${stderr.slice(-800)}`); }
  const result = { schemaVersion:1, backend:'adb', device:serial, probes:probed, status:underlying.status, failure:underlying.failure, evidence:underlying.evidence, steps:underlying.steps ?? [], flashExit: exit, source:'existing-taphound-flash', plan:opts.planPath };
  await writeFile(join(opts.out,'field-result.json'), JSON.stringify(result,null,2)+'\n');
  return result;
}
async function main() {
  const opts = parseOptions(process.argv.slice(2));
  const plan = validatePlan(JSON.parse(await readFile(opts.planPath,'utf8')));
  const { runner, probed } = await choose(opts,plan);
  let observer;
  try {
    if (opts.command === 'probe') {
      const selected = { status: 'ready', selected: runner.kind, device: runner.device, crashMonitoring: !!runner.crashSerial, logcatAvailable: !!runner.crashSerial, probes: probed };
      console.log(JSON.stringify(selected,null,2)); return;
    }
    if (plan.logChecks?.length) {
      await mkdir(opts.out, { recursive:true });
      if (!runner.crashSerial) throw fail('LOGCAT_UNAVAILABLE','Logcat verification requires ADB access to the selected Android device');
      try { observer = await new LogcatObserver(runner.crashSerial).start(); }
      catch (error) {
        // A broken logger must never be reported as a successful full-chain verification.
        const result = { schemaVersion:2, backend:runner.kind, status:'inconclusive',
          failure:{code:'LOGCAT_UNAVAILABLE',message:message(error)},device:runner.device,plan:opts.planPath,steps:[],probes:probed };
        await writeFile(join(opts.out,'field-result.json'),JSON.stringify(result,null,2)+'\n');
        console.log(JSON.stringify(result,null,2));process.exitCode=4;return;
      }
    }
    const result = runner.kind === 'adb'
      ? await runAdb(opts,plan,probed,runner.device)
      : await runUi(runner,opts,plan,probed);
    const uiFinishedAt = Date.now();
    if (observer !== undefined) {
      // A late asynchronous callback can produce its log after UI settles.
      if (result.status === 'passed') await observer.wait(Math.max(0,...plan.logChecks.map(x=>x.timeoutMs ?? 1500)));
      const logEvidence = await observer.finish(opts.out);
      const assessment = evaluateLogChecks(plan.logChecks, result.steps, observer, uiFinishedAt + Math.max(0,...plan.logChecks.map(x=>x.timeoutMs ?? 1500)));
      observer = undefined;
      result.logcat = { ...logEvidence, ...assessment };
      if (result.status === 'passed') {
        if (assessment.status === 'passed' && plan.verificationMode === 'full'
          && !plan.logChecks.some(x => (x.minCount ?? (x.maxCount === 0 ? 0 : 1)) > 0)) {
          result.status = 'inconclusive';
          result.failure = {code:'POSITIVE_LOG_EVIDENCE_MISSING',message:'Negative-only Logcat checks do not prove execution of the required business path'};
        } else if (assessment.status === 'failed') {
          result.status = 'failed';
          result.failure = {code:'LOG_CHAIN_MISMATCH',message:'Observed Logcat events contradict the required execution chain'};
        } else if (assessment.status !== 'passed') {
          result.status = 'inconclusive';
          result.failure = {code:'LOG_EVIDENCE_INSUFFICIENT',message:'Required Logcat evidence was not established'};
        }
      }
      await writeFile(join(opts.out,'field-result.json'),JSON.stringify(result,null,2)+'\n');
    }
    if (plan.verificationMode === 'full' && !plan.logChecks?.length && result.status === 'passed') {
      result.status = 'inconclusive';
      result.failure = {code:'LOG_ORACLE_NOT_DEFINED',message:'Full-chain verification requires app-derived Logcat checks or separately documented independent integration evidence'};
      await writeFile(join(opts.out,'field-result.json'),JSON.stringify(result,null,2)+'\n');
    }
    console.log(JSON.stringify(result,null,2));
    if (result.status !== 'passed') process.exitCode = result.status === 'inconclusive' ? 4
      : result.status === 'error' ? (runner.kind === 'adb' && result.flashExit >= 2 ? result.flashExit : 3) : 1;
  } finally { await observer?.finish(opts.out).catch(()=>undefined); await runner.close?.(); }
}
try { await main(); }
catch (error) { console.log(JSON.stringify({ status:'error', code:error.code || 'RUNNER_ERROR', message: message(error) },null,2)); process.exitCode = error.code === 'PLAN_INVALID' || error.code === 'USAGE' ? 2 : 3; }
