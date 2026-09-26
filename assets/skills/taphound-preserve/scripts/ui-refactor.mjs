#!/usr/bin/env node
// Skill-side cross-version evidence gate. This does not relax Core's
// same-Journey baseline compare or claim pixel/visual equivalence.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  copyFile, lstat, mkdtemp, readFile, readdir, realpath, rename, rm,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const sha = (value) => /^[a-f0-9]{64}$/.test(value);
const id = (value) => typeof value === "string"
  && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const pause = (message) => { throw new Error(message); };
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const fileHash = async (path) => hash(await readFile(path));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
const journeyHash = (value) => hash(JSON.stringify(canonical(value)));
async function file(path) {
  const actual = resolve(path);
  if (!isAbsolute(path) || await realpath(actual) !== actual
    || !(await lstat(actual)).isFile()) {
    pause("Evidence must be a regular absolute file with no symlink parents");
  }
  return actual;
}
async function root(path) {
  const actual = resolve(path);
  if (!isAbsolute(path) || await realpath(actual) !== actual
    || !(await lstat(actual)).isDirectory()) {
    pause("Workspace must be an absolute non-symlink directory");
  }
  return actual;
}
function checkCase(value) {
  if (value.version !== 1 || !id(value.caseId)
    || typeof value.sourceRef !== "string" || !value.sourceRef.trim()
    || !/^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+$/.test(value.packageName ?? "")
    || typeof value.goal !== "string" || !value.goal.trim()
    || typeof value.fixtureRef !== "string" || !value.fixtureRef.trim()
    || !Array.isArray(value.scenario) || value.scenario.length === 0
    || value.scenario.some((step) => typeof step !== "string" || !step.trim())
    || !Array.isArray(value.observables) || value.observables.length === 0
    || value.observables.some((fact) => !validObservable(fact))
    || new Set(value.observables.map((fact) => fact.id)).size !== value.observables.length
    || Object.keys(value).sort().join(",")
      !== "caseId,fixtureRef,goal,observables,packageName,scenario,sourceRef,version") {
    pause("Frozen UI-refactor Case must have at least one concrete, distinct observable");
  }
}
function validLocator(locator) {
  if (locator === null || typeof locator !== "object"
    || Object.keys(locator).length !== 1) return false;
  const key = Object.keys(locator)[0];
  return ["resourceId", "text", "contentDescription"].includes(key)
    && typeof locator[key] === "string" && locator[key].trim().length > 0;
}
function validEvent(expect) {
  const fieldValues = expect?.fields !== null && typeof expect?.fields === "object"
    && !Array.isArray(expect.fields) ? Object.values(expect.fields) : [];
  if (expect === null || typeof expect !== "object"
    || expect.type !== "logcatEvent"
    || typeof expect.tag !== "string" || !expect.tag.trim()
    || typeof expect.event !== "string" || !expect.event.trim()
    || expect.fields === null || typeof expect.fields !== "object"
    || Array.isArray(expect.fields) || expect.unique !== true
    || fieldValues.some((value) => !(
      typeof value === "boolean"
      || typeof value === "number" && Number.isFinite(value)
      || typeof value === "string" && value.length <= 512
    ))
    || expect.capture !== undefined
    || !["stepStart", "runStart", "marker"].includes(expect.window?.from)
    || (expect.window.from === "marker") !== id(expect.window.markerId)
    || Object.keys(expect.window).sort().join(",") !== (
      expect.window.from === "marker" ? "from,markerId" : "from"
    )) return false;
  const keys = Object.keys(expect).sort().join(",");
  return keys === "event,fields,tag,type,unique,window";
}
function validObservable(fact) {
  if (!id(fact?.id) || !Number.isInteger(fact.timeoutMs)
    || fact.timeoutMs <= 0 || fact.timeoutMs > 60000) return false;
  if (fact.kind === "visibleText") {
    return Object.keys(fact).sort().join(",") === "afterAction,id,kind,text,timeoutMs"
      && ["click", "wait"].includes(fact.afterAction)
      && typeof fact.text === "string" && fact.text.trim().length > 0;
  }
  if (fact.kind === "visibleElement" || fact.kind === "absentElement") {
    return Object.keys(fact).sort().join(",") === "id,kind,locator,timeoutMs"
      && validLocator(fact.locator);
  }
  if (fact.kind === "logcatEvent") {
    return Object.keys(fact).sort().join(",") === "expect,id,kind,timeoutMs"
      && validEvent(fact.expect);
  }
  return false;
}
function expectedCheckpoint(fact) {
  const condition = fact.kind === "logcatEvent"
    ? { kind: "logcatEvent", expect: fact.expect }
    : { kind: fact.kind, locator: fact.locator };
  return { condition, expect: { allOf: [condition], timeoutMs: fact.timeoutMs } };
}
function checkpointMatches(actual, expected) {
  if (actual === null || typeof actual !== "object"
    || actual.timeoutMs !== expected.timeoutMs
    || !Array.isArray(actual.allOf) || actual.allOf.length !== 1
    || JSON.stringify(canonical(actual.allOf[0]))
      !== JSON.stringify(canonical(expected.allOf[0]))) {
    return false;
  }
  return Object.keys(actual).every((key) => ["allOf", "timeoutMs"].includes(key));
}
function observablePassed(report, evidence) {
  if (evidence.source === "step") {
    return report.steps[evidence.index]?.expectation?.status === "passed";
  }
  const checkpoint = report.checkpoints?.find((entry) => entry.id === evidence.id);
  return checkpoint?.status === "passed"
    && checkpoint.conditions.length === 1
    && checkpoint.conditions[0]?.status === "passed";
}
function validCheckpointReport(checkpoint) {
  if (checkpoint.conditions?.length !== 1
    || !["passed", "failed", "unresolved"].includes(checkpoint.status)
    || checkpoint.status !== checkpoint.conditions[0].status) return false;
  const condition = checkpoint.conditions[0];
  if (condition.kind === "logcatEvent" && condition.status === "passed") {
    return condition.matchedCount === 1
      && sha(condition.matchedLineSha256)
      && Number.isFinite(condition.matchedAtMs)
      && typeof condition.evidenceRef === "string"
      && condition.evidenceRef.length > 0;
  }
  return true;
}
function checkReplay(project, device, caseData, journey, meta, report, reportPath) {
  if (journey.version !== 2 || !journey.steps?.length
    || !journey.devices?.some((entry) => entry.role === "default")
    || !Array.isArray(journey.steps)
    || meta.version !== 1 || !["verified", "promoted"].includes(meta.status)
    || typeof meta.generationId !== "string"
    || !sha(meta.bindings?.projectHash) || !sha(meta.bindings?.configHash)
    || !sha(meta.bindings?.contextHash)
    || !sha(meta.verification?.reportSha256)
    || meta.journeyPath === undefined
    || !meta.replayPolicy?.generatedReplayPolicy
    || !meta.replayPolicy?.requireFocusedInput
    || meta.journeySha256 !== journeyHash(journey)
    || report.schemaVersion !== 4
    || report.project?.packageName !== caseData.packageName
    || resolve(report.project?.root ?? "") !== project
    || report.environment?.devices?.length !== 1
    || report.environment.devices[0].deviceSerial !== device
    || report.journey?.sha256 !== meta.journeySha256
    || report.journey.name !== journey.name
    || resolve(report.artifacts?.directory ?? "") !== dirname(reportPath)
    || !Array.isArray(report.steps) || report.steps.length > journey.steps.length
    || (report.status === "passed" && report.steps.length !== journey.steps.length)
    || report.steps.some((step, index) => step.index !== index
      || journey.steps[index] === undefined
      || step.action !== journey.steps[index].action)
    || report.fallbackUsed !== false) {
    pause("Independent Replay, strict policy, target project and Journey do not bind");
  }
  const covered = [];
  for (const fact of caseData.observables) {
    if (fact.kind === "visibleText") {
      const expected = {
        type: "element", locator: { text: fact.text }, timeoutMs: fact.timeoutMs
      };
      const matches = journey.steps.map((step, index) =>
        step.action === fact.afterAction
          && JSON.stringify(canonical(step.expect)) === JSON.stringify(canonical(expected))
          ? index : -1).filter((index) => index >= 0);
      if (matches.length !== 1 || (report.status === "passed"
        && report.steps[matches[0]]?.expectation?.type !== "element")
        || (report.steps[matches[0]]?.expectation !== undefined
          && report.steps[matches[0]].expectation.type !== "element")) {
        pause(`Observable ${fact.id} is missing, duplicated, or unsupported in this Journey`);
      }
      covered.push({ id: fact.id, source: "step", index: matches[0] });
      continue;
    }
    const expected = expectedCheckpoint(fact);
    const definitions = (journey.checkpoints ?? []).filter(
      (checkpoint) => checkpoint.id === fact.id
    );
    if (definitions.length !== 1 || definitions[0].version !== 1
      || !checkpointMatches(definitions[0].expect, expected.expect)) {
      pause(`Observable ${fact.id} needs one exact dedicated Checkpoint`);
    }
    const reports = (report.checkpoints ?? []).filter((checkpoint) =>
      checkpoint.id === fact.id);
    if (reports.length > 1 || (report.status === "passed" && reports.length !== 1)
      || (reports[0] !== undefined && (
        !validCheckpointReport(reports[0])
        ||
        reports[0].conditions.length !== 1
        || JSON.stringify(canonical({
          kind: reports[0].conditions[0]?.kind,
          ...("locator" in (reports[0].conditions[0] ?? {})
            ? { locator: reports[0].conditions[0].locator }
            : { expect: reports[0].conditions[0]?.expect })
        })) !== JSON.stringify(canonical(expected.condition))
      ))) {
      pause(`Observable ${fact.id} Checkpoint report is missing or changed`);
    }
    covered.push({ id: fact.id, source: "checkpoint", index: fact.id });
  }
  if (new Set(covered.map((entry) => `${entry.source}:${String(entry.index)}`)).size
    !== covered.length) {
    pause("Distinct observable facts must have separate evidence identities");
  }
  return covered;
}
async function checkReceipt(receiptPath, project, journeyPath, reportPath,
  device, hashes, expectedExit = 0) {
  const receipt = await json(receiptPath);
  if (receipt.version !== 1 || receipt.exitCode !== expectedExit
    || !Array.isArray(receipt.argv) || receipt.argv[0] !== "verify"
    || !receipt.argv.includes("--policy-from-meta") || !receipt.argv.includes("--json")
    || receipt.argv.includes("--contract")
    || receipt.argv[receipt.argv.indexOf("--project") + 1] !== project
    || receipt.argv[receipt.argv.indexOf("--journey") + 1] !== journeyPath
    || receipt.argv[receipt.argv.indexOf("--device") + 1] !== device
    || receipt.journeySha256 !== hashes.journey
    || receipt.reportSha256 !== hashes.report
    || receipt.reportPath !== reportPath
    || Object.keys(receipt).sort().join(",")
      !== "argv,exitCode,journeySha256,reportPath,reportSha256,version") {
    pause("Independent strict verify process receipt is unavailable or does not bind the run");
  }
}
const bundleFiles = [
  "case.json", "before-journey.json", "before-meta.json",
  "before-report.json", "before-receipt.json"
];
async function publish(inputPath, sharedPath) {
  const input = await json(await file(inputPath));
  const base = await root(input.base?.projectRoot);
  const shared = await root(sharedPath);
  if (inside(base, shared)) pause("Shared Case directory must be outside the historical project");
  const casePath = await file(input.casePath);
  if (!inside(base, casePath) || inside(join(base, ".taphound", "build"), casePath)) {
    pause("Frozen Case must belong to historical committed project assets");
  }
  const caseData = await json(casePath);
  checkCase(caseData);
  if (input.version !== 1 || caseData.caseId !== input.caseId
    || caseData.packageName !== input.base.packageName
    || !sha(input.base.apkSha256) || !/^[a-zA-Z0-9._:-]+$/.test(input.base.deviceSerial ?? "")
    || await fileHash(await file(input.base.apkPath)) !== input.base.apkSha256) {
    pause("Case/package/device or A's locally built APK attestation is invalid");
  }
  const journeyPath = await file(input.before?.journeyPath);
  const metaPath = await file(input.before?.metaPath);
  const reportPath = await file(input.before?.reportPath);
  const receiptPath = await file(input.before?.receiptPath);
  if (!inside(join(base, ".taphound", "journeys"), journeyPath)
    || metaPath !== journeyPath.replace(/\.json$/, ".meta.json")
    || !inside(base, reportPath) || !inside(base, receiptPath)) {
    pause("Historical Journey/meta and Replay evidence must belong to the base project");
  }
  const expectedInputKeys = "base,before,caseId,casePath,version";
  const expectedBaseKeys = "apkPath,apkSha256,deviceSerial,packageName,projectRoot";
  const expectedBeforeKeys = "journeyPath,metaPath,receiptPath,reportPath";
  if (Object.keys(input).sort().join(",") !== expectedInputKeys
    || Object.keys(input.base).sort().join(",") !== expectedBaseKeys
    || Object.keys(input.before).sort().join(",") !== expectedBeforeKeys) {
    pause("Preparation input contains unsupported fields");
  }
  const journey = await json(journeyPath);
  const meta = await json(metaPath);
  const report = await json(reportPath);
  if (meta.journeyPath !== relative(base, journeyPath).split(sep).join("/")) {
    pause("Historical meta does not bind its conventional Journey path");
  }
  const covered = checkReplay(base, input.base.deviceSerial,
    caseData, journey, meta, report, reportPath);
  const hashes = {
    journey: journeyHash(journey), report: await fileHash(reportPath)
  };
  await checkReceipt(receiptPath, base, journeyPath, reportPath,
    input.base.deviceSerial, hashes);
  if (report.status !== "passed"
    || report.steps.some((step) => step.status !== "passed")
    || covered.some((entry) => !observablePassed(report, entry))) {
    pause("Historical APK has no passing evidence for all frozen observables");
  }
  const git = spawnSync("git", ["-C", base, "rev-parse", "HEAD"], {
    encoding: "utf8", timeout: 10000
  });
  if (git.status !== 0 || !/^[a-f0-9]{40,64}$/.test(git.stdout.trim())) {
    pause("Historical Git commit is unavailable");
  }
  const output = join(shared, caseData.caseId);
  try {
    await lstat(output);
    pause("Case already published; silent overwrite is forbidden");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stage = await mkdtemp(join(shared, `.ui-refactor-${caseData.caseId}-`));
  const sources = [
    casePath, journeyPath, metaPath, reportPath, receiptPath
  ];
  try {
    const before = await Promise.all(sources.map(fileHash));
    for (const [index, name] of bundleFiles.entries()) {
      const source = sources[index];
      if (source === undefined) pause("Internal bundle source inventory is incomplete");
      await copyFile(source, join(stage, name), constants.COPYFILE_EXCL);
    }
    const artifacts = {};
    for (const name of bundleFiles) {
      artifacts[name] = await fileHash(join(stage, name));
    }
    const after = await Promise.all(sources.map(fileHash));
    if (before.some((value, index) => value !== after[index]
      || bundleFiles[index] === undefined
      || value !== artifacts[bundleFiles[index]])) pause("Before-run assets changed during export");
    const md = [
      "# UI-refactor Preserve handoff", "",
      `Case: \`${caseData.caseId}\` (READY)`,
      `Goal: ${caseData.goal}`,
      `Test fixture reference: \`${caseData.fixtureRef}\``,
      `Base Git commit: \`${git.stdout.trim()}\``,
      `Package: \`${caseData.packageName}\`; device: \`${input.base.deviceSerial}\``,
      `Old built/installed APK hash (Agent A attestation): \`${input.base.apkSha256}\``,
      `Old report: \`${report.runId}\` (passed)`,
      "", "| Frozen file | SHA-256 |", "|---|---|",
      ...Object.entries(artifacts).map(([name, value]) =>
        `| \`${name}\` | \`${value}\` |`),
      "", "B receives only this path. Validate the Case bundle before device work.",
      "Generate a NEW Journey and strict independent Replay for the same",
      "frozen observables. Old Journey/meta are audit-only, not staged in B.",
      ""
    ].join("\n");
    await writeFile(join(stage, "handoff.md"), md, { flag: "wx" });
    await writeFile(join(stage, "handoff.json"), `${JSON.stringify({
      version: 1, status: "READY", caseId: caseData.caseId,
      base: {
        projectRoot: base, commit: git.stdout.trim(), device: input.base.deviceSerial,
        apkSha256: input.base.apkSha256, runId: report.runId
      },
      artifacts, mdSha256: hash(md)
    }, null, 2)}\n`, { flag: "wx" });
    await rename(stage, output);
    return { status: "READY", handoff: join(output, "handoff.md") };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
async function validate(handoffPath, targetPath) {
  const handoff = await file(handoffPath);
  if (handoff.split(sep).at(-1) !== "handoff.md") pause("B only accepts the MD handoff path");
  const dir = await root(dirname(handoff));
  const manifestPath = await file(join(dir, "handoff.json"));
  const manifest = await json(manifestPath);
  const md = await readFile(handoff, "utf8");
  if (manifest.version !== 1 || manifest.status !== "READY"
    || !id(manifest.caseId) || manifest.caseId !== dir.split(sep).at(-1)
    || !sha(manifest.mdSha256) || hash(md) !== manifest.mdSha256
    || !/^[a-f0-9]{40,64}$/.test(manifest.base?.commit ?? "")
    || !sha(manifest.base?.apkSha256)
    || !isAbsolute(manifest.base?.projectRoot ?? "")
    || !manifest.artifacts || typeof manifest.artifacts !== "object"
    || JSON.stringify((await readdir(dir)).sort()) !== JSON.stringify(
      [...bundleFiles, "handoff.md", "handoff.json"].sort())
    || Object.keys(manifest.artifacts).sort().join(",") !== bundleFiles.slice().sort().join(",")) {
    pause("Handoff MD, manifest and file inventory disagree");
  }
  for (const name of bundleFiles) {
    const path = await file(join(dir, name));
    if (!sha(manifest.artifacts[name]) || await fileHash(path) !== manifest.artifacts[name]
      || !md.includes(`| \`${name}\` | \`${manifest.artifacts[name]}\` |`)) {
      pause("Frozen historical file or MD digest changed");
    }
  }
  const caseData = await json(join(dir, "case.json"));
  checkCase(caseData);
  if (caseData.caseId !== manifest.caseId) pause("Frozen Case identity changed");
  const journey = await json(join(dir, "before-journey.json"));
  const meta = await json(join(dir, "before-meta.json"));
  const report = await json(join(dir, "before-report.json"));
  const originalJourney = join(manifest.base.projectRoot, meta.journeyPath ?? "");
  const originalReport = join(report.artifacts?.directory ?? "", "report.json");
  if (!inside(manifest.base.projectRoot, originalJourney)
    || !inside(manifest.base.projectRoot, originalReport)
    || report.runId !== manifest.base.runId
    || caseData.packageName !== report.project?.packageName) {
    pause("Historical evidence provenance disagrees with frozen Case");
  }
  await checkReceipt(join(dir, "before-receipt.json"), manifest.base.projectRoot,
    originalJourney, originalReport, manifest.base.device, {
      journey: journeyHash(journey), report: manifest.artifacts["before-report.json"]
    });
  const covered = checkReplay(manifest.base.projectRoot, manifest.base.device,
    caseData, journey, meta, report, originalReport);
  if (report.status !== "passed"
    || covered.some((entry) => !observablePassed(report, entry))) {
    pause("Historical observable evidence is not passed");
  }
  if (targetPath !== undefined) {
    const project = await root(targetPath);
    const configPath = await file(join(project, ".taphound", "config.json"));
    const config = await json(configPath);
    if (config.run?.packageName !== caseData.packageName) {
      pause("Target package is not the frozen Case package");
    }
  }
  return { status: "READY", caseId: caseData.caseId, dir, caseData, manifest };
}
async function compare(handoff, projectPath, journeyPath, reportPath, receiptPath) {
  const data = await validate(handoff, projectPath);
  const project = await root(projectPath);
  const journeyFile = await file(journeyPath);
  const metaFile = await file(journeyFile.replace(/\.json$/, ".meta.json"));
  const reportFile = await file(reportPath);
  const receiptFile = await file(receiptPath);
  if (!inside(join(project, ".taphound", "journeys"), journeyFile)
    || !inside(project, reportFile) || !inside(project, receiptFile)
    || !inside(project, metaFile)) pause("Target evidence must belong to B's project");
  const journey = await json(journeyFile);
  const meta = await json(metaFile);
  const report = await json(reportFile);
  if (meta.journeyPath !== relative(project, journeyFile).split(sep).join("/")) {
    pause("New strict meta does not bind B's generated Journey path");
  }
  await checkReceipt(receiptFile, project, journeyFile, reportFile,
    data.manifest.base.device, {
      journey: journeyHash(journey), report: await fileHash(reportFile)
    }, report.status === "failed" ? 4 : 0);
  const covered = checkReplay(project, data.manifest.base.device,
    data.caseData, journey, meta, report, reportFile);
  if (report.runId === data.manifest.base.runId) {
    pause("Before and after evidence must come from independent run IDs");
  }
  if (report.journey.sha256 === (await json(join(data.dir, "before-report.json"))).journey.sha256) {
    pause("UI-refactor mode needs a newly authored Journey, not the frozen old one");
  }
  const failed = covered.filter((entry) =>
    !observablePassed(report, entry));
  if (report.status === "error" || report.status === "manualRequired") {
    pause("Target Replay did not produce comparable device evidence");
  }
  if (report.status === "failed"
    && (report.primaryFailure?.code === undefined || report.layers?.run !== "failed"
      || !report.steps.some((step) => step.status === "failed"))) {
    pause("Failed target report lacks a deterministic primary Replay failure");
  }
  const outcome = report.status !== "passed" || failed.length > 0 ? "FAIL" : "PASS";
  return {
    status: outcome, caseId: data.caseId,
    coverage: { required: covered.length, evidenced: covered.length - failed.length },
    beforeRunId: data.manifest.base.runId, afterRunId: report.runId,
    beforeJourneySha256: (await json(join(data.dir, "before-report.json"))).journey.sha256,
    afterJourneySha256: report.journey.sha256,
    ...(failed.length === 0 ? {} : { failedObservables: failed.map((entry) => entry.id) })
  };
}
const [operation, ...args] = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= args.length) pause(`Missing --${name}`);
  return args[index + 1];
}
try {
  const result = operation === "prepare"
    ? await publish(flag("input"), flag("out"))
    : operation === "validate"
      ? await validate(flag("handoff"), args.includes("--project") ? flag("project") : undefined)
      : operation === "compare"
        ? await compare(flag("handoff"), flag("project"), flag("journey"),
          flag("report"), flag("receipt"))
        : pause("Use prepare, validate or compare");
  const publicResult = operation === "validate"
    ? { status: result.status, caseId: result.caseId } : result;
  process.stdout.write(`${JSON.stringify(publicResult)}\n`);
  process.exitCode = result.status === "FAIL" ? 1 : 0;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: "PAUSED", reason: error instanceof Error ? error.message : String(error)
  })}\n`);
  process.exitCode = 2;
}
