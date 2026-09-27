#!/usr/bin/env node
// taphound-flash: a zero-dependency smoke check for an installed Android app.
//
//   node flash.mjs run <plan.json> [--device <serial>] [--out <dir>]
//
// Needs Node.js 18+ and adb (on PATH, or set ADB=/path/to/adb). Prints one
// JSON result to stdout. Exit codes: 0 passed, 1 failed, 2 invalid plan or
// usage, 3 environment (adb, device, or app unavailable).
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const NOTICE = "Smoke check only, not verification evidence: use taphound-verify-change to prove a change.";
const DUMP_PATH = "/sdcard/taphound-flash.xml";
const POLL_MS = 250;
// Shell commands that change what the device shows.
const MUTATIONS = new Set(["input", "am", "monkey", "wm"]);
const TARGET_KEYS = ["id", "text", "desc"];
const ACTIONS = {
  tap: ["target"],
  type: ["text"],
  back: [],
  wait: ["ms"],
  expect: ["target", "absent", "timeoutMs"],
  expectActivity: ["activity", "timeoutMs"]
};

class FlashError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}


// ---------------------------------------------------------------- plan

function fail(message) {
  throw new FlashError("PLAN_INVALID", message, 2);
}

function onlyKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${where}: unknown field "${key}"`);
  }
}

function positiveInt(value, where) {
  if (!Number.isInteger(value) || value <= 0) fail(`${where} must be a positive integer`);
  return value;
}

function parseTarget(value, where) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${where} must be an object with one of ${TARGET_KEYS.join(", ")}`);
  }
  onlyKeys(value, TARGET_KEYS, where);
  const keys = Object.keys(value);
  if (keys.length !== 1 || typeof value[keys[0]] !== "string" || value[keys[0]] === "") {
    fail(`${where} needs exactly one non-empty ${TARGET_KEYS.join("/")} string`);
  }
  return value;
}

export function parsePlan(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("plan must be an object");
  onlyKeys(value, ["version", "packageName", "activity", "device", "timeoutMs", "settleTimeoutMs", "steps"], "plan");
  if (value.version !== 1) fail("plan.version must be 1");
  if (typeof value.packageName !== "string" || !/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(value.packageName)) {
    fail("plan.packageName must be an Android package name");
  }
  if (value.activity !== undefined && (typeof value.activity !== "string" || value.activity === "")) {
    fail("plan.activity must be a non-empty string");
  }
  if (value.device !== undefined && (typeof value.device !== "string" || value.device === "")) {
    fail("plan.device must be a non-empty string");
  }
  const plan = {
    packageName: value.packageName,
    activity: value.activity,
    device: value.device,
    timeoutMs: value.timeoutMs === undefined ? 10_000 : positiveInt(value.timeoutMs, "plan.timeoutMs"),
    settleTimeoutMs: value.settleTimeoutMs === undefined
      ? 5_000
      : positiveInt(value.settleTimeoutMs, "plan.settleTimeoutMs"),
    steps: []
  };
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 50) {
    fail("plan.steps must hold 1 to 50 steps");
  }
  for (const [index, step] of value.steps.entries()) {
    const where = `steps[${index}]`;
    if (step === null || typeof step !== "object" || typeof step.action !== "string") {
      fail(`${where} needs an action`);
    }
    const fields = ACTIONS[step.action];
    if (fields === undefined) fail(`${where}: unknown action "${step.action}"`);
    onlyKeys(step, ["action", ...fields], where);
    const parsed = { action: step.action };
    if (fields.includes("target")) parsed.target = parseTarget(step.target, `${where}.target`);
    if (step.action === "type") {
      if (typeof step.text !== "string" || !/^[\x20-\x7e]+$/.test(step.text)) {
        fail(`${where}.text must be printable ASCII (adb input cannot type other characters)`);
      }
      parsed.text = step.text;
    }
    if (step.action === "wait") parsed.ms = positiveInt(step.ms, `${where}.ms`);
    if (step.action === "expect") {
      if (step.absent !== undefined && typeof step.absent !== "boolean") fail(`${where}.absent must be a boolean`);
      parsed.absent = step.absent === true;
    }
    if (step.action === "expectActivity") {
      if (typeof step.activity !== "string" || step.activity === "") fail(`${where}.activity must be a non-empty string`);
      parsed.activity = step.activity;
    }
    if (step.timeoutMs !== undefined) parsed.timeoutMs = positiveInt(step.timeoutMs, `${where}.timeoutMs`);
    plan.steps.push(parsed);
  }
  return plan;
}

// ---------------------------------------------------------------- adb

function adbBinary() {
  return process.env.ADB ?? "adb";
}

function adb(args, { binary = false, timeoutMs = 30_000 } = {}) {
  return new Promise((done, reject) => {
    execFile(adbBinary(), args, {
      encoding: binary ? "buffer" : "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      shell: false
    }, (error, stdout, stderr) => {
      if (error !== null && error.code === "ENOENT") {
        reject(new FlashError("ADB_MISSING", `adb not found (${adbBinary()}); install Android platform-tools or set ADB`, 3));
        return;
      }
      done({ code: error === null ? 0 : (typeof error.code === "number" ? error.code : 1), stdout, stderr: String(stderr) });
    });
  });
}

class Device {
  constructor(serial, packageName) {
    this.serial = serial;
    this.packageName = packageName;
    // The last settled UI dump, valid until the next device mutation or wait.
    this.settled = undefined;
  }

  /** The settled dump once, then fresh dumps (it may be stale after a poll). */
  async observe() {
    const cached = this.settled;
    this.settled = undefined;
    return cached ?? this.dump();
  }

  run(args, options) {
    if (args[0] === "shell" && MUTATIONS.has(args[1])) this.settled = undefined;
    return adb(["-s", this.serial, ...args], options);
  }

  async shell(args, what) {
    const result = await this.run(["shell", ...args]);
    if (result.code !== 0) {
      throw new FlashError("ADB_FAILED", `${what} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result.stdout;
  }

  async pid() {
    const result = await this.run(["shell", "pidof", this.packageName]);
    return result.stdout.trim();
  }

  async foreground() {
    const activities = await this.run(["shell", "dumpsys", "activity", "activities"]);
    const match = /(?:topResumedActivity|mResumedActivity|ResumedActivity)[=:]\s*ActivityRecord\{\S+ \S+ ([\w.]+)\/([\w.$]+)/
      .exec(activities.stdout);
    if (match !== null) return { packageName: match[1], activity: qualify(match[1], match[2]) };
    const windows = await this.run(["shell", "dumpsys", "window"]);
    const focus = /mCurrentFocus=Window\{\S+ \S+ ([\w.]+)\/([\w.$]+)\}/.exec(windows.stdout);
    return focus === null
      ? { packageName: "", activity: "" }
      : { packageName: focus[1], activity: qualify(focus[1], focus[2]) };
  }

  async dump() {
    const dumped = await this.run(["shell", "uiautomator", "dump", DUMP_PATH]);
    if (dumped.code !== 0 || !/dumped to/i.test(dumped.stdout)) {
      throw new FlashError("UI_DUMP_FAILED", `uiautomator dump failed: ${(dumped.stderr || dumped.stdout).trim()}`);
    }
    const read = await this.run(["exec-out", "cat", DUMP_PATH]);
    if (read.code !== 0 || !read.stdout.includes("<hierarchy")) {
      throw new FlashError("UI_DUMP_FAILED", "Could not read the UI hierarchy dump");
    }
    return read.stdout;
  }
}

function qualify(packageName, activity) {
  return activity.startsWith(".") ? `${packageName}${activity}` : activity;
}

// ---------------------------------------------------------------- layout

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

function decode(value) {
  return value.replace(/&(#x?[\da-fA-F]+|\w+);/g, (whole, name) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });
}

export function parseHierarchy(xml) {
  const nodes = [];
  const stack = [];
  const token = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  let match;
  while ((match = token.exec(xml)) !== null) {
    if (match[0] === "</node>") {
      stack.pop();
      continue;
    }
    const attributes = {};
    for (const [, key, value] of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) attributes[key] = decode(value);
    const bounds = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attributes.bounds ?? "");
    const node = {
      id: attributes["resource-id"] ?? "",
      text: attributes.text ?? "",
      desc: attributes["content-desc"] ?? "",
      packageName: attributes.package ?? "",
      clickable: attributes.clickable === "true",
      enabled: attributes.enabled !== "false",
      bounds: bounds === null ? undefined : bounds.slice(1).map(Number),
      parent: stack.at(-1)
    };
    nodes.push(node);
    if (match[2] !== "/") stack.push(node);
  }
  return nodes;
}

function describe(target) {
  const [key] = Object.keys(target);
  return `${key}=${JSON.stringify(target[key])}`;
}

export function findTarget(nodes, target, packageName) {
  const inApp = nodes.filter((node) => node.packageName === packageName);
  if (target.id !== undefined) {
    return inApp.filter((node) => node.id === target.id || node.id.endsWith(`:id/${target.id}`));
  }
  if (target.text !== undefined) return inApp.filter((node) => node.text === target.text);
  return inApp.filter((node) => node.desc === target.desc);
}

function center(bounds) {
  return [Math.round((bounds[0] + bounds[2]) / 2), Math.round((bounds[1] + bounds[3]) / 2)];
}

/**
 * The touch point for a matched element: its own center, handled by the
 * element itself or its nearest clickable ancestor (the same rule as
 * TapHound Core), so a label inside a row taps the label, not the row center.
 */
export function tapPoint(node) {
  let handler = node;
  while (handler !== undefined && !handler.clickable) handler = handler.parent;
  if (handler === undefined) {
    throw new FlashError("NOT_CLICKABLE", "Neither the target nor any ancestor is clickable");
  }
  if (!handler.enabled) throw new FlashError("TARGET_DISABLED", "The element that handles the tap is disabled");
  const own = node.bounds === undefined ? undefined : center(node.bounds);
  const box = handler.bounds;
  if (own !== undefined && box !== undefined
    && own[0] >= box[0] && own[0] < box[2] && own[1] >= box[1] && own[1] < box[3]) {
    return own;
  }
  if (box === undefined) throw new FlashError("NOT_CLICKABLE", "The tap target has no bounds");
  return center(box);
}

// ---------------------------------------------------------------- runner

async function settle(device, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previous = await device.dump();
  for (;;) {
    await sleep(POLL_MS);
    const current = await device.dump();
    if (current === previous) {
      device.settled = current;
      return current;
    }
    if (Date.now() >= deadline) {
      throw new FlashError("UNSETTLED", `The UI kept changing for ${timeoutMs} ms`);
    }
    previous = current;
  }
}

async function assertInApp(device) {
  if (await device.pid() === "") throw new FlashError("APP_CRASHED", `${device.packageName} is no longer running`);
  const foreground = await device.foreground();
  if (foreground.packageName !== device.packageName) {
    throw new FlashError("LEFT_APP", `Foreground is ${foreground.packageName || "unknown"}, not ${device.packageName}`);
  }
}

async function poll(timeoutMs, attempt) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const outcome = await attempt();
    if (outcome.done) return outcome.value;
    if (Date.now() >= deadline) throw outcome.error;
    await sleep(POLL_MS);
  }
}

async function keyguardShowing(device) {
  const windows = await device.run(["shell", "dumpsys", "window"]);
  return /isKeyguardShowing=true|mDreamingLockscreen=true|mShowingLockscreen=true/.test(windows.stdout);
}

/** A sleeping or locked screen hides the app from the UI hierarchy. */
async function ensureAwake(device) {
  const power = await device.run(["shell", "dumpsys", "power"]);
  if (/mWakefulness=(Asleep|Dozing)/.test(power.stdout)) {
    await device.shell(["input", "keyevent", "224"], "wake up");
    await sleep(500);
  }
  if (await keyguardShowing(device)) {
    await device.run(["shell", "wm", "dismiss-keyguard"]);
    await sleep(1_000);
    if (await keyguardShowing(device)) {
      throw new FlashError(
        "DEVICE_LOCKED",
        "The device is locked; unlock it first (a secure lock screen cannot be dismissed over adb)",
        3
      );
    }
  }
}

function visiblePackages(nodes) {
  return [...new Set(nodes.map((node) => node.packageName).filter((name) => name !== ""))];
}

async function launch(device, plan) {
  await ensureAwake(device);
  await device.shell(["am", "force-stop", plan.packageName], "force-stop");
  const started = plan.activity === undefined
    ? await device.run(["shell", "monkey", "-p", plan.packageName, "-c", "android.intent.category.LAUNCHER", "1"])
    : await device.run(["shell", "am", "start", "-W", "-n", `${plan.packageName}/${plan.activity}`]);
  if (started.code !== 0 || /^Error|No activities found|monkey aborted/im.test(started.stdout)) {
    throw new FlashError("LAUNCH_FAILED", `Could not launch ${plan.packageName}: ${(started.stdout + started.stderr).trim()}`);
  }
  await poll(plan.timeoutMs, async () => ((await device.pid()) === ""
    ? { done: false, error: new FlashError("LAUNCH_FAILED", "The app process did not start") }
    : { done: true }));
  await assertInApp(device);
  await poll(plan.timeoutMs, async () => {
    const nodes = parseHierarchy(await settle(device, plan.settleTimeoutMs));
    return nodes.some((node) => node.packageName === plan.packageName)
      ? { done: true }
      : {
          done: false,
          error: new FlashError(
            "APP_NOT_VISIBLE",
            `The app runs but its UI is not visible; the screen shows ${visiblePackages(nodes).join(", ") || "nothing"}`
          )
        };
  });
}

async function runStep(device, plan, step) {
  const timeoutMs = step.timeoutMs ?? plan.timeoutMs;
  switch (step.action) {
    case "tap": {
      const node = await poll(timeoutMs, async () => {
        const matches = findTarget(parseHierarchy(await device.observe()), step.target, plan.packageName);
        if (matches.length === 1) return { done: true, value: matches[0] };
        if (matches.length > 1) {
          throw new FlashError("TARGET_AMBIGUOUS", `${describe(step.target)} matches ${matches.length} elements`);
        }
        return { done: false, error: new FlashError("TARGET_NOT_FOUND", `No element with ${describe(step.target)}`) };
      });
      const [x, y] = tapPoint(node);
      await device.shell(["input", "tap", String(x), String(y)], "tap");
      return `tapped ${describe(step.target)} at ${x},${y}`;
    }
    case "type": {
      const escaped = step.text.replace(/[\\"'`$&|;<>()*~!#?[\]{}]/g, (character) => `\\${character}`).replaceAll(" ", "%s");
      await device.shell(["input", "text", escaped], "input text");
      return `typed ${step.text.length} characters`;
    }
    case "back":
      await device.shell(["input", "keyevent", "4"], "back");
      return "pressed back";
    case "wait":
      device.settled = undefined;
      await sleep(step.ms);
      return `waited ${step.ms} ms`;
    case "expect":
      return poll(timeoutMs, async () => {
        const matches = findTarget(parseHierarchy(await device.observe()), step.target, plan.packageName);
        if (step.absent) {
          return matches.length === 0
            ? { done: true, value: `${describe(step.target)} is absent` }
            : { done: false, error: new FlashError("EXPECT_FAILED", `${describe(step.target)} is still shown`) };
        }
        if (matches.length === 1) return { done: true, value: `${describe(step.target)} is shown` };
        return {
          done: false,
          error: new FlashError(
            matches.length > 1 ? "TARGET_AMBIGUOUS" : "EXPECT_FAILED",
            matches.length > 1
              ? `${describe(step.target)} matches ${matches.length} elements`
              : `${describe(step.target)} did not appear within ${timeoutMs} ms`
          )
        };
      });
    case "expectActivity": {
      const expected = qualify(plan.packageName, step.activity);
      return poll(timeoutMs, async () => {
        const { activity } = await device.foreground();
        return activity === expected
          ? { done: true, value: `${expected} is in the foreground` }
          : { done: false, error: new FlashError("ACTIVITY_MISMATCH", `Expected ${expected}, found ${activity || "none"}`) };
      });
    }
    default:
      throw new FlashError("PLAN_INVALID", `Unknown action ${step.action}`, 2);
  }
}

async function selectDevice(requested) {
  const listed = await adb(["devices"]);
  const online = listed.stdout.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === "device")
    .map((parts) => parts[0]);
  if (requested !== undefined) {
    if (!online.includes(requested)) throw new FlashError("DEVICE_UNAVAILABLE", `Device ${requested} is not online`, 3);
    return requested;
  }
  if (online.length !== 1) {
    throw new FlashError("DEVICE_UNAVAILABLE", `Expected exactly one online device, found ${online.length}; pass --device`, 3);
  }
  return online[0];
}

async function collectFailureEvidence(device, dir, code) {
  const evidence = {};
  try {
    const shot = await device.run(["exec-out", "screencap", "-p"], { binary: true });
    if (shot.code === 0 && shot.stdout.length > 0) {
      evidence.screenshot = join(dir, "failure.png");
      await writeFile(evidence.screenshot, shot.stdout);
    }
  } catch { /* best effort */ }
  try {
    evidence.hierarchy = join(dir, "failure.xml");
    await writeFile(evidence.hierarchy, await device.dump());
  } catch {
    delete evidence.hierarchy;
  }
  if (code === "APP_CRASHED" || code === "LEFT_APP") {
    const crash = await device.run(["logcat", "-d", "-b", "crash", "-t", "200"]);
    if (crash.code === 0 && crash.stdout.trim() !== "") {
      evidence.crashLog = join(dir, "crash.txt");
      await writeFile(evidence.crashLog, crash.stdout);
    }
  }
  return evidence;
}

export async function runPlan(plan, { device: requested, out }) {
  const startedAt = Date.now();
  const serial = await selectDevice(requested ?? plan.device);
  const device = new Device(serial, plan.packageName);
  const installed = await device.run(["shell", "pm", "path", plan.packageName]);
  if (!installed.stdout.includes("package:")) {
    throw new FlashError("APP_NOT_INSTALLED", `${plan.packageName} is not installed on ${serial}`, 3);
  }
  await mkdir(out, { recursive: true });
  const steps = plan.steps.map((step, index) => ({ index, action: step.action, status: "notRun" }));
  const result = {
    tool: "taphound-flash",
    version: 1,
    status: "passed",
    device: serial,
    packageName: plan.packageName,
    steps,
    evidence: { dir: out },
    notice: NOTICE
  };
  let current = -1;
  try {
    await launch(device, plan);
    for (const [index, step] of plan.steps.entries()) {
      current = index;
      const stepStartedAt = Date.now();
      steps[index].detail = await runStep(device, plan, step);
      if (step.action !== "expect" && step.action !== "expectActivity") {
        await settle(device, plan.settleTimeoutMs);
      }
      await assertInApp(device);
      steps[index].status = "passed";
      steps[index].durationMs = Date.now() - stepStartedAt;
    }
    const shot = await device.run(["exec-out", "screencap", "-p"], { binary: true });
    if (shot.code === 0 && shot.stdout.length > 0) {
      result.evidence.screenshot = join(out, "final.png");
      await writeFile(result.evidence.screenshot, shot.stdout);
    }
  } catch (error) {
    if (!(error instanceof FlashError) || error.exitCode !== 1) throw error;
    result.status = "failed";
    result.failure = { stepIndex: current === -1 ? null : current, code: error.code, message: error.message };
    if (current !== -1) {
      steps[current].status = "failed";
      steps[current].detail = error.message;
    }
    Object.assign(result.evidence, await collectFailureEvidence(device, out, error.code));
  }
  result.durationMs = Date.now() - startedAt;
  return result;
}

// ---------------------------------------------------------------- cli

function parseArgs(argv) {
  const [command, planPath, ...rest] = argv;
  if (command !== "run" || planPath === undefined) {
    throw new FlashError("USAGE", "Usage: flash.mjs run <plan.json> [--device <serial>] [--out <dir>]", 2);
  }
  const options = { planPath };
  for (let index = 0; index < rest.length; index += 2) {
    const [flag, value] = [rest[index], rest[index + 1]];
    if ((flag !== "--device" && flag !== "--out") || value === undefined) {
      throw new FlashError("USAGE", `Unknown or incomplete option ${flag}`, 2);
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

async function main() {
  let exitCode;
  let output;
  try {
    const options = parseArgs(process.argv.slice(2));
    let raw;
    try {
      raw = JSON.parse(await readFile(options.planPath, "utf8"));
    } catch (error) {
      throw new FlashError("PLAN_INVALID", `Cannot read plan ${options.planPath}: ${error.message}`, 2);
    }
    const plan = parsePlan(raw);
    const out = resolve(options.out ?? join(tmpdir(), "taphound-flash", new Date().toISOString().replaceAll(":", "-")));
    output = await runPlan(plan, { device: options.device, out });
    exitCode = output.status === "passed" ? 0 : 1;
  } catch (error) {
    const code = error instanceof FlashError ? error.code : "INTERNAL_ERROR";
    exitCode = error instanceof FlashError ? error.exitCode : 1;
    output = { tool: "taphound-flash", version: 1, status: "error", failure: { code, message: error.message }, notice: NOTICE };
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = exitCode;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
