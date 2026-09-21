#!/usr/bin/env node
import { createHash } from "node:crypto";
import process from "node:process";
import {
  access, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile
} from "node:fs/promises";
import {
  dirname, isAbsolute, join, relative, resolve, sep
} from "node:path";

const CATALOG = "cases.json";
const LEDGER = "case-ledger.json";
const STATUS = "STATUS.md";
const LOCK = ".case-ledger.lock";
const shaPattern = /^[a-f0-9]{64}$/;
const caseIdPattern = /^[A-Z][A-Z0-9_-]{0,63}$/;
const suiteIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const flowNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/;
const terminalStates = new Set(["verified", "archived"]);
const inactiveStates = new Set(["pending", ...terminalStates]);
const statuses = new Set([
  "pending", "briefing", "briefReady", "generating", "recoveryRequired",
  "verificationPending", "verificationFailed", "blocked", "verified", "archived"
]);
const transitions = new Map([
  ["pending", new Set(["briefing", "blocked", "archived"])],
  ["briefing", new Set(["briefReady", "blocked", "archived"])],
  ["briefReady", new Set(["briefing", "generating", "blocked", "archived"])],
  ["generating", new Set([
    "recoveryRequired", "verificationPending", "blocked", "archived"
  ])],
  ["recoveryRequired", new Set([
    "generating", "verificationPending", "blocked", "archived"
  ])],
  ["verificationPending", new Set([
    "recoveryRequired", "verificationFailed", "verified", "blocked", "archived"
  ])],
  ["verificationFailed", new Set(["generating", "blocked", "archived"])],
  ["blocked", new Set([
    "pending", "briefing", "briefReady", "generating", "recoveryRequired",
    "verificationPending", "verificationFailed", "archived"
  ])],
  ["verified", new Set()],
  ["archived", new Set()]
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

function canonicalHash(value) {
  return digest(JSON.stringify(canonical(value)));
}

function exactKeys(value, required, optional = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("CASE_SUITE_INVALID", "Expected a JSON object");
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("CASE_SUITE_INVALID", `Unknown field "${key}"`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      fail("CASE_SUITE_INVALID", `Missing required field "${key}"`);
    }
  }
}

function nonempty(value, label, max = 1000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    fail("CASE_SUITE_INVALID", `${label} must be a non-empty string`);
  }
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    fail("CASE_SUITE_INVALID", `${label} must be an integer >= ${String(minimum)}`);
  }
  return value;
}

function assertSha(value, label) {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    fail("CASE_SUITE_INVALID", `${label} must be a lowercase SHA-256`);
  }
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (
    rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  );
}

function projectPath(value, label) {
  const path = nonempty(value, label);
  if (isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")
    || path.startsWith("./") || path.endsWith("/")) {
    fail("CASE_SUITE_INVALID", `${label} must be a normalized project-relative path`);
  }
  return path;
}

async function json(path, label = path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail("CASE_SUITE_INVALID", `${label} is not readable JSON: ${String(error)}`);
  }
}

async function exactHash(path) {
  return digest(await readFile(path));
}

async function regularProjectFile(projectRoot, artifact, label) {
  exactKeys(artifact, ["path", "sha256"]);
  const relativePath = projectPath(artifact.path, `${label}.path`);
  assertSha(artifact.sha256, `${label}.sha256`);
  const absolute = resolve(projectRoot, relativePath);
  if (!inside(projectRoot, absolute)) {
    fail("CASE_SUITE_INVALID", `${label} escapes the project`);
  }
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    fail("CASE_SUITE_INVALID", `${label} does not exist: ${relativePath}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    fail("CASE_SUITE_INVALID", `${label} must be a regular non-symlink file`);
  }
  const resolved = await realpath(absolute);
  if (!inside(projectRoot, resolved)) {
    fail("CASE_SUITE_INVALID", `${label} resolves outside the project`);
  }
  const actual = await exactHash(resolved);
  if (actual !== artifact.sha256) {
    fail("CASE_SUITE_STALE", `${label} hash changed`);
  }
  return { absolute: resolved, relativePath };
}

function parseArtifact(value, label) {
  exactKeys(value, ["path", "sha256"]);
  projectPath(value.path, `${label}.path`);
  assertSha(value.sha256, `${label}.sha256`);
  return { path: value.path, sha256: value.sha256 };
}

function parseFailure(value) {
  exactKeys(value, ["code", "message"]);
  return {
    code: nonempty(value.code, "failure.code", 200),
    message: nonempty(value.message, "failure.message", 1000)
  };
}

function parseGeneration(value) {
  exactKeys(value, ["id"], ["baseFlow"]);
  const generation = { id: nonempty(value.id, "generation.id", 200) };
  if (value.baseFlow !== undefined) {
    generation.baseFlow = nonempty(value.baseFlow, "generation.baseFlow", 200);
  }
  return generation;
}

function parseCatalogCase(value) {
  exactKeys(
    value,
    ["id", "order", "title", "sourceText", "risk", "dependsOn"],
    ["plannedBaseFlow"]
  );
  const id = nonempty(value.id, "case.id", 64);
  if (!caseIdPattern.test(id)) {
    fail("CASE_SUITE_INVALID", `Invalid Case ID ${id}`);
  }
  if (!["readOnly", "stateChanging", "external"].includes(value.risk)) {
    fail("CASE_SUITE_INVALID", `Invalid risk for ${id}`);
  }
  if (!Array.isArray(value.dependsOn)
    || value.dependsOn.some((entry) => typeof entry !== "string")) {
    fail("CASE_SUITE_INVALID", `dependsOn for ${id} must be a string array`);
  }
  if (new Set(value.dependsOn).size !== value.dependsOn.length) {
    fail("CASE_SUITE_INVALID", `Case ${id} has duplicate dependencies`);
  }
  return {
    id,
    order: integer(value.order, `${id}.order`, 1),
    title: nonempty(value.title, `${id}.title`, 200),
    sourceText: nonempty(value.sourceText, `${id}.sourceText`, 10000),
    risk: value.risk,
    dependsOn: [...value.dependsOn],
    ...(value.plannedBaseFlow === undefined
      ? {}
      : {
          plannedBaseFlow: nonempty(
            value.plannedBaseFlow, `${id}.plannedBaseFlow`, 200
          )
        })
  };
}

function assertCatalogGraph(cases) {
  const ids = new Set();
  const orders = new Set();
  for (const entry of cases) {
    if (ids.has(entry.id)) fail("CASE_SUITE_INVALID", `Duplicate Case ID ${entry.id}`);
    if (orders.has(entry.order)) {
      fail("CASE_SUITE_INVALID", `Duplicate Case order ${String(entry.order)}`);
    }
    ids.add(entry.id);
    orders.add(entry.order);
  }
  for (const entry of cases) {
    for (const dependency of entry.dependsOn) {
      if (!ids.has(dependency) || dependency === entry.id) {
        fail("CASE_SUITE_INVALID", `Invalid dependency ${dependency} for ${entry.id}`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  const visit = (id) => {
    if (visiting.has(id)) fail("CASE_SUITE_INVALID", `Case dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const entry of cases) visit(entry.id);
}

function parseCatalog(value) {
  exactKeys(value, [
    "version", "kind", "suiteId", "title", "projectRoot",
    "contextPath", "createdAt", "cases"
  ], ["deviceSerial"]);
  if (value.version !== 1 || value.kind !== "taphound.caseCatalog"
    || !suiteIdPattern.test(value.suiteId ?? "")
    || !isAbsolute(value.projectRoot ?? "")
    || !Array.isArray(value.cases) || value.cases.length === 0) {
    fail("CASE_SUITE_INVALID", "Invalid frozen Case catalog");
  }
  projectPath(value.contextPath, "contextPath");
  nonempty(value.createdAt, "createdAt");
  const cases = value.cases.map(parseCatalogCase).sort(
    (left, right) => left.order - right.order
  );
  assertCatalogGraph(cases);
  return { ...value, cases };
}

function parseLedger(value, catalog) {
  exactKeys(value, [
    "version", "kind", "suiteId", "revision", "catalog",
    "devicePolicy", "baseFlows", "cases", "updatedAt"
  ]);
  if (value.version !== 1 || value.kind !== "taphound.caseLedger"
    || value.suiteId !== catalog.suiteId || !Array.isArray(value.cases)
    || !Array.isArray(value.baseFlows)) {
    fail("CASE_SUITE_INVALID", "Invalid Case Ledger identity");
  }
  integer(value.revision, "ledger.revision");
  exactKeys(value.catalog, ["path", "sha256"]);
  if (value.catalog.path !== CATALOG) {
    fail("CASE_SUITE_INVALID", "Ledger catalog path must be cases.json");
  }
  assertSha(value.catalog.sha256, "ledger.catalog.sha256");
  exactKeys(value.devicePolicy, ["concurrency"], ["deviceSerial"]);
  if (value.devicePolicy.concurrency !== "serial"
    || value.devicePolicy.deviceSerial !== catalog.deviceSerial) {
    fail("CASE_SUITE_INVALID", "Ledger device policy does not match the catalog");
  }
  const catalogById = new Map(catalog.cases.map((entry) => [entry.id, entry]));
  if (value.cases.length !== catalog.cases.length) {
    fail("CASE_SUITE_INVALID", "Ledger Case count differs from the catalog");
  }
  for (const entry of value.cases) {
    exactKeys(entry, [
      "id", "order", "title", "sourceSha256", "risk", "dependsOn",
      "status", "history"
    ], [
      "plannedBaseFlow", "resumeStatus", "brief", "generation", "failure",
      "nextAction", "completion"
    ]);
    const source = catalogById.get(entry.id);
    if (source === undefined || entry.order !== source.order
      || entry.title !== source.title || entry.risk !== source.risk
      || JSON.stringify(entry.dependsOn) !== JSON.stringify(source.dependsOn)
      || entry.plannedBaseFlow !== source.plannedBaseFlow
      || entry.sourceSha256 !== digest(source.sourceText)
      || !statuses.has(entry.status) || !Array.isArray(entry.history)) {
      fail("CASE_SUITE_INVALID", `Ledger Case ${String(entry.id)} drifted from catalog`);
    }
    if (entry.brief !== undefined) parseArtifact(entry.brief, `${entry.id}.brief`);
    if (entry.generation !== undefined) parseGeneration(entry.generation);
    if (entry.failure !== undefined) parseFailure(entry.failure);
    if (entry.completion !== undefined) parseCompletion(entry.completion);
    if (entry.resumeStatus !== undefined && !statuses.has(entry.resumeStatus)) {
      fail("CASE_SUITE_INVALID", `Invalid resumeStatus for ${entry.id}`);
    }
    for (const history of entry.history) {
      exactKeys(history, ["to", "at", "reason"], ["from"]);
      if (!statuses.has(history.to)
        || history.from !== undefined && !statuses.has(history.from)) {
        fail("CASE_SUITE_INVALID", `Invalid transition history for ${entry.id}`);
      }
      nonempty(history.at, `${entry.id}.history.at`, 100);
      nonempty(history.reason, `${entry.id}.history.reason`, 500);
    }
    if (entry.status === "verified" && entry.completion === undefined) {
      fail("CASE_SUITE_INVALID", `Verified Case ${entry.id} lacks completion evidence`);
    }
    if (["recoveryRequired", "verificationFailed", "blocked"].includes(entry.status)
      && (entry.failure === undefined || entry.nextAction === undefined)) {
      fail("CASE_SUITE_INVALID", `${entry.status} Case ${entry.id} lacks recovery details`);
    }
  }
  const active = value.cases.filter((entry) => !inactiveStates.has(entry.status));
  if (active.length > 1) {
    fail("CASE_SUITE_CONFLICT", "Serial device policy allows only one active Case");
  }
  const flowNames = new Set();
  for (const flow of value.baseFlows) {
    exactKeys(flow, [
      "name", "status", "path", "sha256", "exitActivity", "journey",
      "resolutionManifest", "report", "recordedAt"
    ]);
    if (!flowNamePattern.test(flow.name ?? "") || flow.status !== "verified") {
      fail("CASE_SUITE_INVALID", "Invalid recorded Base Flow");
    }
    projectPath(flow.path, `${flow.name}.path`);
    assertSha(flow.sha256, `${flow.name}.sha256`);
    nonempty(flow.exitActivity, `${flow.name}.exitActivity`, 500);
    parseArtifact(flow.journey, `${flow.name}.journey`);
    parseArtifact(flow.resolutionManifest, `${flow.name}.resolutionManifest`);
    parseArtifact(flow.report, `${flow.name}.report`);
    nonempty(flow.recordedAt, `${flow.name}.recordedAt`, 100);
    if (flowNames.has(flow.name)) {
      fail("CASE_SUITE_INVALID", `Duplicate Base Flow ${flow.name}`);
    }
    flowNames.add(flow.name);
  }
  return value;
}

function parseCompletion(value) {
  exactKeys(value, ["journey", "meta", "finalReport", "independentReport"]);
  return {
    journey: parseArtifact(value.journey, "completion.journey"),
    meta: parseArtifact(value.meta, "completion.meta"),
    finalReport: parseArtifact(value.finalReport, "completion.finalReport"),
    independentReport: parseArtifact(
      value.independentReport, "completion.independentReport"
    )
  };
}

async function loadSuite(suitePath) {
  const root = await realpath(resolve(suitePath)).catch(() => {
    fail("CASE_SUITE_INVALID", `Suite directory does not exist: ${suitePath}`);
  });
  const catalogPath = join(root, CATALOG);
  const ledgerPath = join(root, LEDGER);
  const catalogBytes = await readFile(catalogPath).catch(() => {
    fail("CASE_SUITE_INVALID", `Missing ${CATALOG}`);
  });
  let catalogValue;
  try {
    catalogValue = JSON.parse(catalogBytes.toString("utf8"));
  } catch {
    fail("CASE_SUITE_INVALID", `${CATALOG} is invalid JSON`);
  }
  const catalog = parseCatalog(catalogValue);
  const projectRoot = await realpath(catalog.projectRoot).catch(() => {
    fail("CASE_SUITE_INVALID", "Catalog projectRoot does not exist");
  });
  if (projectRoot !== catalog.projectRoot || !inside(projectRoot, root)) {
    fail("CASE_SUITE_INVALID", "Suite must stay beneath canonical projectRoot");
  }
  const ledger = parseLedger(await json(ledgerPath, LEDGER), catalog);
  const catalogSha256 = digest(catalogBytes);
  if (ledger.catalog.sha256 !== catalogSha256) {
    fail("CASE_SUITE_STALE", "Frozen Case catalog hash changed");
  }
  const suite = {
    root, projectRoot, catalog, ledger, ledgerPath, catalogSha256
  };
  for (const entry of ledger.cases) {
    if (entry.brief !== undefined) {
      await regularProjectFile(projectRoot, entry.brief, `${entry.id}.brief`);
    }
    if (entry.status === "verified") {
      await validateCompletion(suite, entry, entry.completion);
    }
  }
  for (const flow of ledger.baseFlows) {
    await validateFlowEvidence(suite, flow);
  }
  return suite;
}

async function atomicWrite(path, content) {
  const temporary = join(
    dirname(path),
    `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function statusMarkdown(catalog, ledger) {
  const counts = Object.fromEntries(
    [...statuses].map((status) => [
      status, ledger.cases.filter((entry) => entry.status === status).length
    ])
  );
  const rows = ledger.cases
    .slice()
    .sort((left, right) => left.order - right.order)
    .map((entry) => {
      const marker = entry.status === "verified"
        ? "x"
        : entry.status === "archived" ? "-" : " ";
      const flow = entry.plannedBaseFlow ?? "";
      const next = entry.nextAction?.replaceAll("|", "\\|") ?? "";
      return `| [${marker}] | ${entry.id} | ${entry.title.replaceAll("|", "\\|")} | ${entry.status} | ${flow} | ${next} |`;
    });
  return [
    `# ${catalog.title}`,
    "",
    `Suite: \`${catalog.suiteId}\`  `,
    `Ledger revision: ${String(ledger.revision)}  `,
    `Updated: ${ledger.updatedAt}`,
    "",
    `Verified: ${String(counts.verified)} / ${String(ledger.cases.length)}`,
    "",
    "| Done | Case | Title | Status | Base Flow | Next action |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "> Generated from case-ledger.json. Do not edit this file manually.",
    ""
  ].join("\n");
}

async function withLock(suite, callback) {
  const lockPath = join(suite.root, LOCK);
  let handle;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString()
    }));
  } catch {
    fail("CASE_SUITE_LOCKED", "Another Case Suite update holds the Ledger lock");
  }
  try {
    const fresh = await loadSuite(suite.root);
    return await callback(fresh);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(lockPath, { force: true });
  }
}

async function recoverLock(suitePath) {
  const suite = await loadSuite(suitePath);
  const lockPath = join(suite.root, LOCK);
  let lock;
  try {
    lock = await json(lockPath, "Ledger lock");
  } catch (error) {
    if (error?.code === "CASE_SUITE_INVALID") {
      fail("CASE_SUITE_LOCK_INVALID", "Ledger lock is missing or unreadable");
    }
    throw error;
  }
  if (!Number.isInteger(lock.pid) || lock.pid <= 0
    || typeof lock.createdAt !== "string") {
    fail("CASE_SUITE_LOCK_INVALID", "Ledger lock metadata is invalid");
  }
  let alive = true;
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    alive = error?.code !== "ESRCH";
  }
  if (alive) {
    fail("CASE_SUITE_LOCKED", `Ledger lock owner PID ${String(lock.pid)} is alive`);
  }
  await rm(lockPath);
  return {
    status: "lockRecovered",
    suiteId: suite.ledger.suiteId,
    previousPid: lock.pid
  };
}

async function persist(suite, ledger) {
  parseLedger(ledger, suite.catalog);
  await atomicWrite(
    suite.ledgerPath,
    `${JSON.stringify(ledger, null, 2)}\n`
  );
  await atomicWrite(
    join(suite.root, STATUS),
    statusMarkdown(suite.catalog, ledger)
  );
}

function parseSuiteInput(value) {
  exactKeys(
    value,
    ["version", "suiteId", "title", "projectRoot", "cases"],
    ["deviceSerial", "contextPath"]
  );
  if (value.version !== 1 || !suiteIdPattern.test(value.suiteId ?? "")
    || !isAbsolute(value.projectRoot ?? "")
    || !Array.isArray(value.cases) || value.cases.length === 0) {
    fail("CASE_SUITE_INVALID", "Invalid Suite initialization input");
  }
  const cases = value.cases.map(parseCatalogCase).sort(
    (left, right) => left.order - right.order
  );
  assertCatalogGraph(cases);
  return {
    version: 1,
    suiteId: value.suiteId,
    title: nonempty(value.title, "title", 200),
    projectRoot: value.projectRoot,
    ...(value.deviceSerial === undefined
      ? {}
      : { deviceSerial: nonempty(value.deviceSerial, "deviceSerial", 200) }),
    contextPath: projectPath(
      value.contextPath ?? ".taphound/context/project-context.json",
      "contextPath"
    ),
    cases
  };
}

async function init(inputPath, outputPath) {
  const input = parseSuiteInput(await json(resolve(inputPath), "Suite input"));
  const projectRoot = await realpath(input.projectRoot);
  const output = resolve(outputPath);
  if (!inside(projectRoot, output) || output === projectRoot) {
    fail("CASE_SUITE_INVALID", "Suite output must be a new directory inside projectRoot");
  }
  await access(output).then(
    () => fail("CASE_SUITE_EXISTS", "Suite output already exists"),
    () => undefined
  );
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const now = new Date().toISOString();
  const catalog = {
    version: 1,
    kind: "taphound.caseCatalog",
    suiteId: input.suiteId,
    title: input.title,
    projectRoot,
    ...(input.deviceSerial === undefined ? {} : { deviceSerial: input.deviceSerial }),
    contextPath: input.contextPath,
    createdAt: now,
    cases: input.cases
  };
  const catalogText = `${JSON.stringify(catalog, null, 2)}\n`;
  const ledger = {
    version: 1,
    kind: "taphound.caseLedger",
    suiteId: input.suiteId,
    revision: 0,
    catalog: { path: CATALOG, sha256: digest(catalogText) },
    devicePolicy: {
      concurrency: "serial",
      ...(input.deviceSerial === undefined ? {} : { deviceSerial: input.deviceSerial })
    },
    baseFlows: [],
    cases: input.cases.map((entry) => ({
      id: entry.id,
      order: entry.order,
      title: entry.title,
      sourceSha256: digest(entry.sourceText),
      risk: entry.risk,
      dependsOn: entry.dependsOn,
      ...(entry.plannedBaseFlow === undefined
        ? {}
        : { plannedBaseFlow: entry.plannedBaseFlow }),
      status: "pending",
      history: [{
        to: "pending",
        at: now,
        reason: "Suite initialized from frozen Case catalog"
      }]
    })),
    updatedAt: now
  };
  try {
    await writeFile(join(output, CATALOG), catalogText, { flag: "wx" });
    await writeFile(
      join(output, LEDGER), `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx" }
    );
    await writeFile(join(output, STATUS), statusMarkdown(catalog, ledger), {
      flag: "wx"
    });
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  return {
    status: "initialized",
    suiteId: input.suiteId,
    suitePath: output,
    catalogSha256: ledger.catalog.sha256,
    revision: 0,
    caseCount: ledger.cases.length
  };
}

function parseTransition(value) {
  exactKeys(
    value,
    ["version", "expectedRevision", "caseId", "from", "to", "reason"],
    ["brief", "generation", "failure", "nextAction", "completion"]
  );
  if (value.version !== 1 || !caseIdPattern.test(value.caseId ?? "")
    || !statuses.has(value.from) || !statuses.has(value.to)) {
    fail("CASE_SUITE_INVALID", "Invalid Case transition identity");
  }
  return {
    expectedRevision: integer(value.expectedRevision, "expectedRevision"),
    caseId: value.caseId,
    from: value.from,
    to: value.to,
    reason: nonempty(value.reason, "reason", 500),
    ...(value.brief === undefined ? {} : { brief: parseArtifact(value.brief, "brief") }),
    ...(value.generation === undefined
      ? {}
      : { generation: parseGeneration(value.generation) }),
    ...(value.failure === undefined
      ? {}
      : { failure: parseFailure(value.failure) }),
    ...(value.nextAction === undefined
      ? {}
      : { nextAction: nonempty(value.nextAction, "nextAction", 1000) }),
    ...(value.completion === undefined
      ? {}
      : { completion: parseCompletion(value.completion) })
  };
}

async function validateCompletion(suite, entry, completion) {
  const journeyFile = await regularProjectFile(
    suite.projectRoot, completion.journey, "completion.journey"
  );
  const metaFile = await regularProjectFile(
    suite.projectRoot, completion.meta, "completion.meta"
  );
  const finalFile = await regularProjectFile(
    suite.projectRoot, completion.finalReport, "completion.finalReport"
  );
  const independentFile = await regularProjectFile(
    suite.projectRoot, completion.independentReport, "completion.independentReport"
  );
  const [journey, meta, finalReport, independentReport] = await Promise.all([
    json(journeyFile.absolute, "Journey"),
    json(metaFile.absolute, "Generation meta"),
    json(finalFile.absolute, "Finalization report"),
    json(independentFile.absolute, "Independent report")
  ]);
  const journeySha256 = canonicalHash(journey);
  if (journey?.version !== 2 || !Array.isArray(journey.steps) || journey.steps.length === 0
    || meta?.version !== 1 || !["verified", "promoted"].includes(meta.status)
    || meta.generationId !== entry.generation?.id
    || meta.journeyPath !== completion.journey.path
    || meta.journeySha256 !== journeySha256
    || meta.replayPolicy?.generatedReplayPolicy !== true
    || meta.replayPolicy?.requireFocusedInput !== true
    || meta.verification?.runs !== 1
    || meta.verification?.reportSha256 !== completion.finalReport.sha256
    || finalReport?.schemaVersion !== 4 || finalReport.status !== "passed"
    || independentReport?.schemaVersion !== 4 || independentReport.status !== "passed"
    || finalReport.journey?.sha256 !== journeySha256
    || independentReport.journey?.sha256 !== journeySha256
    || typeof finalReport.runId !== "string"
    || typeof independentReport.runId !== "string"
    || meta.verification?.runId !== finalReport.runId
    || finalReport.runId === independentReport.runId
    || finalReport.fallbackUsed === true || independentReport.fallbackUsed === true) {
    fail(
      "CASE_SUITE_EVIDENCE_INVALID",
      `Completion evidence does not prove Case ${entry.id}`
    );
  }
}

async function transition(suitePath, inputPath) {
  const request = parseTransition(await json(resolve(inputPath), "Transition input"));
  const loaded = await loadSuite(suitePath);
  return withLock(loaded, async (suite) => {
    if (suite.ledger.revision !== request.expectedRevision) {
      fail(
        "CASE_SUITE_REVISION_CONFLICT",
        `Expected revision ${String(request.expectedRevision)}, found ${String(suite.ledger.revision)}`
      );
    }
    const entry = suite.ledger.cases.find((item) => item.id === request.caseId);
    if (entry === undefined || entry.status !== request.from) {
      fail("CASE_SUITE_CONFLICT", "Case status does not match transition.from");
    }
    if (!transitions.get(request.from)?.has(request.to)) {
      fail(
        "CASE_SUITE_TRANSITION_INVALID",
        `Transition ${request.from} -> ${request.to} is not allowed`
      );
    }
    if (request.from === "blocked" && request.to !== "archived"
      && request.to !== entry.resumeStatus) {
      fail("CASE_SUITE_TRANSITION_INVALID", "Blocked Case must resume its prior state");
    }
    if (request.from === "recoveryRequired" && request.to !== "archived"
      && request.to !== entry.resumeStatus) {
      fail(
        "CASE_SUITE_TRANSITION_INVALID",
        "Recovery must return to the interrupted Case state"
      );
    }
    if (request.to === "briefing") {
      const incomplete = entry.dependsOn.filter((id) => (
        suite.ledger.cases.find((item) => item.id === id)?.status !== "verified"
      ));
      if (incomplete.length > 0) {
        fail(
          "CASE_SUITE_DEPENDENCY_BLOCKED",
          `Case dependencies are not verified: ${incomplete.join(", ")}`
        );
      }
      const active = suite.ledger.cases.find((item) => (
        item.id !== entry.id && !inactiveStates.has(item.status)
      ));
      if (active !== undefined) {
        fail("CASE_SUITE_CONFLICT", `Case ${active.id} is already active`);
      }
    }
    const brief = request.brief ?? entry.brief;
    const generation = request.generation ?? entry.generation;
    if (request.to === "briefReady") {
      if (request.brief === undefined) {
        fail("CASE_SUITE_INVALID", "briefReady requires a bound Brief");
      }
      const briefFile = await regularProjectFile(
        suite.projectRoot, request.brief, `${entry.id}.brief`
      );
      if (!briefFile.relativePath.endsWith(
        `/briefs/${entry.id}/taphound-journey-brief.md`
      )) {
        fail("CASE_SUITE_INVALID", "Brief path must be Case-specific");
      }
    }
    if (request.to === "generating") {
      if (brief === undefined || generation === undefined) {
        fail("CASE_SUITE_INVALID", "generating requires Brief and generation ID");
      }
      await regularProjectFile(suite.projectRoot, brief, `${entry.id}.brief`);
      if (entry.plannedBaseFlow !== undefined) {
        if (generation.baseFlow !== entry.plannedBaseFlow
          || !suite.ledger.baseFlows.some(
            (flow) => flow.name === generation.baseFlow && flow.status === "verified"
          )) {
          fail(
            "CASE_SUITE_FLOW_UNVERIFIED",
            `Case ${entry.id} requires verified Base Flow ${entry.plannedBaseFlow}`
          );
        }
      } else if (generation.baseFlow !== undefined
        && !suite.ledger.baseFlows.some(
          (flow) => flow.name === generation.baseFlow && flow.status === "verified"
        )) {
        fail("CASE_SUITE_FLOW_UNVERIFIED", "Generation Base Flow is not verified");
      }
    }
    if (["recoveryRequired", "verificationFailed", "blocked"].includes(request.to)
      && (request.failure === undefined || request.nextAction === undefined)) {
      fail("CASE_SUITE_INVALID", `${request.to} requires failure and nextAction`);
    }
    if (["verificationPending", "verificationFailed", "recoveryRequired"].includes(
      request.to
    ) && generation === undefined) {
      fail("CASE_SUITE_INVALID", `${request.to} requires a generation session`);
    }
    if (request.to === "verified") {
      if (request.completion === undefined || generation === undefined) {
        fail("CASE_SUITE_INVALID", "verified requires completion and generation");
      }
      await validateCompletion(suite, { ...entry, generation }, request.completion);
    }
    const now = new Date().toISOString();
    const next = {
      ...entry,
      status: request.to,
      ...(brief === undefined ? {} : { brief }),
      ...(generation === undefined ? {} : { generation }),
      ...(request.failure === undefined ? {} : { failure: request.failure }),
      ...(request.nextAction === undefined ? {} : { nextAction: request.nextAction }),
      ...(request.completion === undefined
        ? {}
        : { completion: request.completion }),
      history: [...entry.history, {
        from: request.from,
        to: request.to,
        at: now,
        reason: request.reason
      }]
    };
    if (["blocked", "recoveryRequired"].includes(request.to)) {
      next.resumeStatus = request.from;
    } else {
      delete next.resumeStatus;
    }
    if (!["blocked", "recoveryRequired", "verificationFailed"].includes(request.to)) {
      if (request.failure === undefined) delete next.failure;
      if (request.nextAction === undefined) delete next.nextAction;
    }
    const ledger = {
      ...suite.ledger,
      revision: suite.ledger.revision + 1,
      cases: suite.ledger.cases.map((item) => item.id === next.id ? next : item),
      updatedAt: now
    };
    await persist(suite, ledger);
    return {
      status: "transitioned",
      suiteId: ledger.suiteId,
      revision: ledger.revision,
      caseId: next.id,
      from: request.from,
      to: request.to
    };
  });
}

function parseFlowRecord(value) {
  exactKeys(value, [
    "version", "expectedRevision", "name", "path", "sha256",
    "exitActivity", "journey", "resolutionManifest", "report"
  ]);
  if (value.version !== 1 || !flowNamePattern.test(value.name ?? "")) {
    fail("CASE_SUITE_INVALID", "Invalid Base Flow record");
  }
  return {
    expectedRevision: integer(value.expectedRevision, "expectedRevision"),
    name: value.name,
    path: projectPath(value.path, "flow.path"),
    sha256: value.sha256,
    exitActivity: nonempty(value.exitActivity, "exitActivity", 500),
    journey: parseArtifact(value.journey, "flow.journey"),
    resolutionManifest: parseArtifact(
      value.resolutionManifest, "flow.resolutionManifest"
    ),
    report: parseArtifact(value.report, "flow.report")
  };
}

async function recordFlow(suitePath, inputPath) {
  const request = parseFlowRecord(await json(resolve(inputPath), "Base Flow record"));
  assertSha(request.sha256, "flow.sha256");
  const loaded = await loadSuite(suitePath);
  return withLock(loaded, async (suite) => {
    if (suite.ledger.revision !== request.expectedRevision) {
      fail("CASE_SUITE_REVISION_CONFLICT", "Base Flow revision is stale");
    }
    if (suite.ledger.cases.some((entry) => !inactiveStates.has(entry.status))) {
      fail("CASE_SUITE_CONFLICT", "Record Base Flows only between active Cases");
    }
    if (suite.ledger.baseFlows.some((flow) => flow.name === request.name)) {
      fail("CASE_SUITE_CONFLICT", `Base Flow ${request.name} is already recorded`);
    }
    const now = new Date().toISOString();
    const recorded = {
      name: request.name,
      status: "verified",
      path: request.path,
      sha256: request.sha256,
      exitActivity: request.exitActivity,
      journey: request.journey,
      resolutionManifest: request.resolutionManifest,
      report: request.report,
      recordedAt: now
    };
    await validateFlowEvidence(suite, recorded);
    const ledger = {
      ...suite.ledger,
      revision: suite.ledger.revision + 1,
      baseFlows: [...suite.ledger.baseFlows, recorded].sort(
        (left, right) => left.name.localeCompare(right.name)
      ),
      updatedAt: now
    };
    await persist(suite, ledger);
    return {
      status: "recorded",
      suiteId: ledger.suiteId,
      revision: ledger.revision,
      baseFlow: request.name
    };
  });
}

async function validateFlowEvidence(suite, flowRecord) {
  const flowArtifact = {
    path: flowRecord.path,
    sha256: flowRecord.sha256
  };
  const flowFile = await regularProjectFile(
    suite.projectRoot, flowArtifact, "Base Flow"
  );
  const journeyFile = await regularProjectFile(
    suite.projectRoot, flowRecord.journey, "Base Flow Journey"
  );
  const manifestFile = await regularProjectFile(
    suite.projectRoot,
    flowRecord.resolutionManifest,
    "Base Flow resolution manifest"
  );
  const reportFile = await regularProjectFile(
    suite.projectRoot, flowRecord.report, "Base Flow report"
  );
  if (flowRecord.path !== `.taphound/flows/${flowRecord.name}.json`) {
    fail("CASE_SUITE_INVALID", "Base Flow path does not match its name");
  }
  const [flow, journey, manifest, report] = await Promise.all([
    json(flowFile.absolute, "Base Flow"),
    json(journeyFile.absolute, "Base Flow Journey"),
    json(manifestFile.absolute, "Base Flow resolution manifest"),
    json(reportFile.absolute, "Base Flow report")
  ]);
  const journeySha256 = canonicalHash(journey);
  const dependency = manifest?.flows?.find(
    (item) => item.name === flowRecord.name
  );
  const {
    resolutionSha256: recordedResolutionSha256,
    ...unsignedManifest
  } = manifest ?? {};
  if (flow?.version !== 1 || flow.kind !== "flow"
    || flow.name !== flowRecord.name
    || journey?.version !== 2 || !Array.isArray(journey.steps)
    || journey.steps.length === 0
    || journey.steps.at(-1)?.activity?.after !== flowRecord.exitActivity
    || manifest?.version !== 1 || dependency?.path !== flowRecord.path
    || dependency?.sha256 !== flowRecord.sha256
    || !Array.isArray(manifest.expansion)
    || manifest.expansion.length !== manifest.flows?.length
    || manifest.flows.some(
      (item, index) => item.name !== manifest.expansion[index]
    )
    || manifest.journey?.sha256 !== journeySha256
    || recordedResolutionSha256 !== canonicalHash(unsignedManifest)
    || report?.schemaVersion !== 4 || report.status !== "passed"
    || report.journey?.sha256 !== journeySha256
    || report.fallbackUsed === true) {
    fail("CASE_SUITE_EVIDENCE_INVALID", "Base Flow proof is not hash-bound and passed");
  }
}

function summary(suite) {
  const counts = Object.fromEntries(
    [...statuses].map((status) => [
      status, suite.ledger.cases.filter((entry) => entry.status === status).length
    ])
  );
  const current = suite.ledger.cases.find(
    (entry) => !inactiveStates.has(entry.status)
  );
  const next = current === undefined
    ? suite.ledger.cases
      .slice()
      .sort((left, right) => left.order - right.order)
      .find((entry) => entry.status === "pending" && entry.dependsOn.every(
        (id) => suite.ledger.cases.find((item) => item.id === id)?.status === "verified"
      ))
    : undefined;
  return {
    status: "valid",
    suiteId: suite.ledger.suiteId,
    revision: suite.ledger.revision,
    catalogSha256: suite.catalogSha256,
    counts,
    ...(current === undefined ? {} : {
      currentCase: {
        id: current.id,
        status: current.status,
        ...(current.generation === undefined
          ? {}
          : { generationId: current.generation.id }),
        ...(current.nextAction === undefined
          ? {}
          : { nextAction: current.nextAction })
      }
    }),
    ...(next === undefined ? {} : { nextCase: { id: next.id, status: next.status } }),
    complete: suite.ledger.cases.every(
      (entry) => terminalStates.has(entry.status)
    )
  };
}

function options(argv, names) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!names.includes(name) || value === undefined) {
      fail("CASE_SUITE_USAGE", `Invalid option ${String(name)}`);
    }
    result[name.slice(2)] = value;
  }
  return result;
}

function help() {
  return [
    "TapHound Case Suite Ledger",
    "",
    "Commands:",
    "  init --input <json> --out <suite-directory>",
    "  validate --suite <suite-directory>",
    "  status --suite <suite-directory>",
    "  transition --suite <suite-directory> --input <json>",
    "  record-flow --suite <suite-directory> --input <json>",
    "  recover-lock --suite <suite-directory>"
  ].join("\n");
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(`${help()}\n`);
    return;
  }
  let output;
  if (command === "init") {
    const input = options(argv, ["--input", "--out"]);
    output = await init(input.input, input.out);
  } else if (command === "validate" || command === "status") {
    const input = options(argv, ["--suite"]);
    output = summary(await loadSuite(input.suite));
  } else if (command === "transition") {
    const input = options(argv, ["--suite", "--input"]);
    output = await transition(input.suite, input.input);
  } else if (command === "record-flow") {
    const input = options(argv, ["--suite", "--input"]);
    output = await recordFlow(input.suite, input.input);
  } else if (command === "recover-lock") {
    const input = options(argv, ["--suite"]);
    output = await recoverLock(input.suite);
  } else {
    fail("CASE_SUITE_USAGE", `Unknown command ${command}`);
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    status: "error",
    code: error?.code ?? "CASE_SUITE_INTERNAL",
    message: error instanceof Error ? error.message : String(error)
  })}\n`);
  process.exitCode = 2;
});
