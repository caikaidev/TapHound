import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir, mkdtemp, readFile, realpath, rm, writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { validReport } from "../../fixtures/report.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const helper = join(
  repo, "assets", "skills", "taphound-case-suite", "scripts", "ledger.mjs"
);
const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map(
    (path) => rm(path, { recursive: true, force: true })
  ));
});

interface HelperOutput {
  status: string;
  code?: string;
  message?: string;
  revision?: number;
  currentCase?: { id: string; status: string };
  nextCase?: { id: string; status: string };
  case?: Record<string, unknown>;
  complete?: boolean;
}

function command(...args: string[]): { code: number; output: HelperOutput } {
  const result = spawnSync(process.execPath, [helper, ...args], {
    encoding: "utf8"
  });
  return {
    code: result.status ?? -1,
    output: JSON.parse(result.stdout) as HelperOutput
  };
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

async function put(path: string, value: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, text);
  return digest(text);
}

async function text(path: string, value: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
  return digest(value);
}

async function setup(options: {
  dependency?: boolean;
  secondCase?: boolean;
  plannedBaseFlow?: string;
} = {}): Promise<{
  root: string;
  suite: string;
  input: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "taphound-case-suite-")));
  created.push(root);
  const suite = join(root, "doc", "development", "suite-1");
  const input = join(root, "suite-input.json");
  await put(input, {
    version: 1,
    suiteId: "suite-1",
    title: "Regression suite",
    projectRoot: root,
    deviceSerial: "emulator-5554",
    contextPath: ".taphound/context/project-context.json",
    cases: [
      {
        id: "CASE-001",
        order: 1,
        title: "Open detail",
        sourceText: "Open the fixture detail page.",
        risk: "readOnly",
        dependsOn: [],
        ...(options.plannedBaseFlow === undefined
          ? {}
          : { plannedBaseFlow: options.plannedBaseFlow })
      },
      ...(options.dependency === true || options.secondCase === true
        ? [{
            id: "CASE-002",
            order: 2,
            title: "Expand detail",
            sourceText: "Expand the first fixture item.",
            risk: "readOnly",
            dependsOn: options.dependency === true ? ["CASE-001"] : []
          }]
        : [])
    ]
  });
  expect(command("init", "--input", input, "--out", suite))
    .toMatchObject({ code: 0, output: { status: "initialized", revision: 0 } });
  return { root, suite, input };
}

async function transition(
  suite: string,
  root: string,
  value: Record<string, unknown>
): Promise<{ code: number; output: HelperOutput }> {
  const input = join(root, `transition-${randomUUID()}.json`);
  await put(input, { version: 1, ...value });
  return command("transition", "--suite", suite, "--input", input);
}

async function bindBrief(
  fixture: { root: string; suite: string },
  expectedRevision: number
): Promise<{ path: string; sha256: string }> {
  const relativePath = "doc/development/suite-1/briefs/CASE-001/taphound-journey-brief.md";
  const sha256 = await text(join(fixture.root, relativePath), "# Goal\n\nOpen detail.\n");
  expect(await transition(fixture.suite, fixture.root, {
    expectedRevision,
    caseId: "CASE-001",
    from: "briefing",
    to: "briefReady",
    reason: "Brief authored",
    brief: { path: relativePath, sha256 }
  })).toMatchObject({
    code: 0,
    output: { status: "transitioned", revision: expectedRevision + 1 }
  });
  return { path: relativePath, sha256 };
}

describe("packaged Case Suite Ledger", () => {
  it("freezes the catalog and resumes from durable status instead of chat", async () => {
    const fixture = await setup({ dependency: true });

    expect(command("status", "--suite", fixture.suite)).toMatchObject({
      code: 0,
      output: {
        status: "valid",
        revision: 0,
        nextCase: { id: "CASE-001", status: "pending" },
        complete: false
      }
    });
    expect(await readFile(join(fixture.suite, "STATUS.md"), "utf8"))
      .toContain("# Regression suite\n");
    const catalog = join(fixture.suite, "cases.json");
    await writeFile(catalog, `${await readFile(catalog, "utf8")} `);
    expect(command("validate", "--suite", fixture.suite)).toMatchObject({
      code: 2,
      output: { status: "error", code: "CASE_SUITE_STALE" }
    });
    expect(command("init", "--input", fixture.input, "--out", fixture.suite))
      .toMatchObject({
        code: 2,
        output: { status: "error", code: "CASE_SUITE_EXISTS" }
      });
  });

  it("enforces revision, dependency, single-active, and exact recovery resume", async () => {
    const fixture = await setup({ dependency: true });
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 0,
      caseId: "CASE-001",
      from: "pending",
      to: "briefing",
      reason: "Claim first Case"
    })).toMatchObject({ code: 0, output: { revision: 1 } });

    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 0,
      caseId: "CASE-002",
      from: "pending",
      to: "briefing",
      reason: "Stale competing agent"
    })).toMatchObject({
      code: 2,
      output: { code: "CASE_SUITE_REVISION_CONFLICT" }
    });
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 1,
      caseId: "CASE-002",
      from: "pending",
      to: "briefing",
      reason: "Skip dependency"
    })).toMatchObject({
      code: 2,
      output: { code: "CASE_SUITE_DEPENDENCY_BLOCKED" }
    });
    await bindBrief(fixture, 1);
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 2,
      caseId: "CASE-001",
      from: "briefReady",
      to: "generating",
      reason: "Start generation",
      generation: { id: "generation-1" }
    })).toMatchObject({ code: 0, output: { revision: 3 } });
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 3,
      caseId: "CASE-001",
      from: "generating",
      to: "recoveryRequired",
      reason: "Interrupted mutation",
      failure: { code: "RECOVERY_REQUIRED", message: "Action may have executed" },
      nextAction: "Ask the user before generation recover"
    })).toMatchObject({ code: 0, output: { revision: 4 } });
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 4,
      caseId: "CASE-001",
      from: "recoveryRequired",
      to: "verificationPending",
      reason: "Invalid recovery destination"
    })).toMatchObject({
      code: 2,
      output: { code: "CASE_SUITE_TRANSITION_INVALID" }
    });
    expect(command("status", "--suite", fixture.suite)).toMatchObject({
      code: 0,
      output: {
        currentCase: { id: "CASE-001", status: "recoveryRequired" }
      }
    });
    await put(join(fixture.suite, ".case-ledger.lock"), {
      pid: 2_147_483_647,
      createdAt: "2026-09-16T00:00:00.000Z"
    });
    expect(command("recover-lock", "--suite", fixture.suite)).toMatchObject({
      code: 0,
      output: { status: "lockRecovered" }
    });
    await put(join(fixture.suite, ".case-ledger.lock"), {
      pid: process.pid,
      createdAt: "2026-09-16T00:00:00.000Z"
    });
    expect(command("recover-lock", "--suite", fixture.suite)).toMatchObject({
      code: 2,
      output: { code: "CASE_SUITE_LOCKED" }
    });
    await rm(join(fixture.suite, ".case-ledger.lock"));
  });

  it("defers multiple Cases without occupying the active slot and resumes exactly", async () => {
    const fixture = await setup({ secondCase: true });
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 0,
      caseId: "CASE-001",
      from: "pending",
      to: "briefing",
      reason: "Claim first Case"
    })).toMatchObject({ code: 0, output: { revision: 1 } });
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 1,
      caseId: "CASE-001",
      from: "briefing",
      to: "blocked",
      reason: "Tool unavailable",
      failure: { code: "TOOL_MISSING", message: "Required tool is unavailable" },
      nextAction: "Install the required tool"
    })).toMatchObject({ code: 0, output: { revision: 2 } });
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 2,
      caseId: "CASE-001",
      from: "blocked",
      to: "deferred",
      reason: "Postpone until the tool is available"
    })).toMatchObject({ code: 0, output: { revision: 3 } });
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 3,
      caseId: "CASE-002",
      from: "pending",
      to: "briefing",
      reason: "Claim second Case"
    })).toMatchObject({ code: 0, output: { revision: 4 } });
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 4,
      caseId: "CASE-002",
      from: "briefing",
      to: "deferred",
      reason: "Postpone second Case",
      failure: { code: "DEFERRED", message: "Waiting for test data" },
      nextAction: "Prepare test data"
    })).toMatchObject({ code: 0, output: { revision: 5 } });

    const caseStatus = command(
      "status", "--suite", fixture.suite, "--case", "CASE-001"
    );
    expect(caseStatus).toMatchObject({
      code: 0,
      output: {
        status: "valid",
        revision: 5,
        case: {
          id: "CASE-001",
          status: "deferred",
          resumeStatus: "briefing",
          failure: { code: "TOOL_MISSING" },
          nextAction: "Install the required tool"
        }
      }
    });
    expect(Array.isArray(caseStatus.output.case?.history)).toBe(true);
    expect(command("status", "--suite", fixture.suite)).toMatchObject({
      code: 0,
      output: { status: "valid", revision: 5, complete: false }
    });
    expect(await readFile(join(fixture.suite, "STATUS.md"), "utf8"))
      .toContain("| deferred |");

    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 5,
      caseId: "CASE-001",
      from: "deferred",
      to: "blocked",
      reason: "Cannot resume to a wrapper state"
    })).toMatchObject({
      code: 2,
      output: { code: "CASE_SUITE_TRANSITION_INVALID" }
    });
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 5,
      caseId: "CASE-001",
      from: "deferred",
      to: "briefing",
      reason: "Tool installed"
    })).toMatchObject({ code: 0, output: { revision: 6 } });
    expect(command(
      "status", "--suite", fixture.suite, "--case", "CASE-001"
    ).output.case).toMatchObject({
      status: "briefing"
    });
    expect(command(
      "status", "--suite", fixture.suite, "--case", "CASE-001"
    ).output.case).not.toHaveProperty("resumeStatus");
    expect(command(
      "status", "--suite", fixture.suite, "--case", "CASE-001"
    ).output.case).not.toHaveProperty("failure");
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 6,
      caseId: "CASE-002",
      from: "deferred",
      to: "briefing",
      reason: "Competing resume"
    })).toMatchObject({
      code: 2,
      output: { code: "CASE_SUITE_CONFLICT" }
    });
  });

  it("returns a coded error when status requests an unknown Case", async () => {
    const fixture = await setup();
    expect(command(
      "status", "--suite", fixture.suite, "--case", "CASE-999"
    )).toMatchObject({
      code: 2,
      output: {
        status: "error",
        code: "CASE_SUITE_CASE_NOT_FOUND",
        message: "Case CASE-999 does not exist"
      }
    });
  });

  it("names the allowed fields and template for an unknown transition field", async () => {
    const fixture = await setup();
    const result = await transition(fixture.suite, fixture.root, {
      expectedRevision: 0,
      caseId: "CASE-001",
      from: "pending",
      to: "briefing",
      reason: "Claim",
      suite: "suite-1"
    });
    expect(result).toMatchObject({
      code: 2,
      output: { status: "error", code: "CASE_SUITE_INVALID" }
    });
    expect(result.output.message).toContain(
      'Unknown field "suite" in transition input; allowed fields: version, '
        + "expectedRevision, caseId, from, to, reason, brief?, generation?, "
        + "failure?, nextAction?, completion?; see "
    );
    expect(result.output.message).toMatch(/templates[/\\]transition\.example\.json$/);
  });

  it("documents the ledger revision rule in help", () => {
    const result = spawnSync(process.execPath, [helper, "help"], { encoding: "utf8" });
    expect(result.stdout).toContain("increments\nledger.revision by exactly 1");
  });

  it("accepts reason and nextAction limits and reports over-limit fields", async () => {
    const reasonLimit = await setup();
    expect(await transition(reasonLimit.suite, reasonLimit.root, {
      expectedRevision: 0,
      caseId: "CASE-001",
      from: "pending",
      to: "deferred",
      reason: "r".repeat(500),
      failure: { code: "DEFERRED", message: "Postponed" },
      nextAction: "n".repeat(1000)
    })).toMatchObject({ code: 0, output: { revision: 1 } });

    const reasonOver = await setup();
    expect(await transition(reasonOver.suite, reasonOver.root, {
      expectedRevision: 0,
      caseId: "CASE-001",
      from: "pending",
      to: "deferred",
      reason: "r".repeat(501),
      failure: { code: "DEFERRED", message: "Postponed" },
      nextAction: "Resume later"
    })).toMatchObject({
      code: 2,
      output: {
        code: "CASE_SUITE_INVALID",
        message: "reason exceeds 500 characters"
      }
    });

    const nextActionOver = await setup();
    expect(await transition(nextActionOver.suite, nextActionOver.root, {
      expectedRevision: 0,
      caseId: "CASE-001",
      from: "pending",
      to: "deferred",
      reason: "Postpone",
      failure: { code: "DEFERRED", message: "Postponed" },
      nextAction: "n".repeat(1001)
    })).toMatchObject({
      code: 2,
      output: {
        code: "CASE_SUITE_INVALID",
        message: "nextAction exceeds 1000 characters"
      }
    });
  });

  it("marks verified only with hash-bound finalization and independent Replay", async () => {
    const fixture = await setup();
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 0,
      caseId: "CASE-001",
      from: "pending",
      to: "briefing",
      reason: "Claim Case"
    })).toMatchObject({ code: 0 });
    await bindBrief(fixture, 1);
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 2,
      caseId: "CASE-001",
      from: "briefReady",
      to: "generating",
      reason: "Start generation",
      generation: { id: "generation-1" }
    })).toMatchObject({ code: 0 });
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 3,
      caseId: "CASE-001",
      from: "generating",
      to: "verificationPending",
      reason: "Candidate complete"
    })).toMatchObject({ code: 0 });

    const journey = {
      version: 2,
      name: "CASE-001",
      devices: [{ role: "default" }],
      steps: [{
        action: "wait",
        activity: {
          before: "com.example.MainActivity",
          after: "com.example.MainActivity"
        }
      }]
    };
    const journeyPath = ".taphound/journeys/CASE-001.json";
    const journeyExactSha = await put(join(fixture.root, journeyPath), journey);
    const journeySha = digest(JSON.stringify(canonical(journey)));
    const finalPath = ".taphound/build/generations/generation-1/verification/report.json";
    const finalReport = validReport({
      runId: "final-run",
      journey: { name: "CASE-001", sha256: journeySha },
      fallbackUsed: false
    });
    const finalSha = await put(join(fixture.root, finalPath), finalReport);
    const metaPath = ".taphound/journeys/CASE-001.meta.json";
    const metaSha = await put(join(fixture.root, metaPath), {
      version: 1,
      status: "verified",
      generationId: "generation-1",
      journeyPath,
      journeySha256: journeySha,
      replayPolicy: {
        generatedReplayPolicy: true,
        requireFocusedInput: true,
        idle: {
          strategy: "hybrid",
          pollIntervalMs: 100,
          stablePolls: 2,
          timeoutMs: 5000
        }
      },
      verification: {
        reportPath: "verification/report.json",
        reportSha256: finalSha,
        runId: "final-run",
        runs: 1
      }
    });
    const independentPath = ".taphound/build/runs/independent/report.json";
    const duplicateRunSha = await put(join(fixture.root, independentPath), finalReport);
    const completion = {
      journey: { path: journeyPath, sha256: journeyExactSha },
      meta: { path: metaPath, sha256: metaSha },
      finalReport: { path: finalPath, sha256: finalSha },
      independentReport: { path: independentPath, sha256: duplicateRunSha }
    };
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 4,
      caseId: "CASE-001",
      from: "verificationPending",
      to: "verified",
      reason: "Attempt without independent Replay",
      completion
    })).toMatchObject({
      code: 2,
      output: { code: "CASE_SUITE_EVIDENCE_INVALID" }
    });

    const independentSha = await put(join(fixture.root, independentPath), {
      ...finalReport,
      runId: "independent-run"
    });
    completion.independentReport.sha256 = independentSha;
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 4,
      caseId: "CASE-001",
      from: "verificationPending",
      to: "verified",
      reason: "Independent Replay passed",
      completion: {
        journey: { path: journeyPath, sha256: "compute" },
        meta: { path: metaPath, sha256: "compute" },
        finalReport: { path: finalPath, sha256: "compute" },
        independentReport: { path: independentPath, sha256: "compute" }
      }
    })).toMatchObject({
      code: 0,
      output: { status: "transitioned", revision: 5 }
    });
    expect(JSON.parse(await readFile(
      join(fixture.suite, "case-ledger.json"), "utf8"
    ))).toMatchObject({
      cases: [{ id: "CASE-001", completion }]
    });
    expect(command("validate", "--suite", fixture.suite)).toMatchObject({
      code: 0,
      output: { status: "valid", complete: true }
    });
    await put(join(fixture.root, independentPath), {
      ...finalReport,
      runId: "tampered-run"
    });
    expect(command("validate", "--suite", fixture.suite)).toMatchObject({
      code: 2,
      output: { code: "CASE_SUITE_STALE" }
    });
  });

  it("refuses a planned Base Flow until verified evidence is recorded", async () => {
    const fixture = await setup({ plannedBaseFlow: "mail/open-detail" });
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 0,
      caseId: "CASE-001",
      from: "pending",
      to: "briefing",
      reason: "Claim Case"
    })).toMatchObject({ code: 0 });
    await bindBrief(fixture, 1);
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 2,
      caseId: "CASE-001",
      from: "briefReady",
      to: "generating",
      reason: "Attempt unverified Base Flow",
      generation: {
        id: "generation-1",
        baseFlow: "mail/open-detail"
      }
    })).toMatchObject({
      code: 2,
      output: { code: "CASE_SUITE_FLOW_UNVERIFIED" }
    });
  });

  it("records a hash-bound verified Base Flow before a planned Case can use it", async () => {
    const flowName = "mail/open-detail";
    const fixture = await setup({ plannedBaseFlow: flowName });
    const flowPath = `.taphound/flows/${flowName}.json`;
    const flow = {
      version: 1,
      kind: "flow",
      name: flowName,
      includes: [],
      steps: [{
        action: "wait",
        activity: {
          before: "com.example.MainActivity",
          after: "com.example.DetailActivity"
        }
      }]
    };
    const flowSha = await put(join(fixture.root, flowPath), flow);
    const journeyPath = ".taphound/journeys/flow-proofs/mail-open-detail.json";
    const journey = {
      version: 2,
      name: flowName,
      devices: [{ role: "default" }],
      steps: flow.steps
    };
    const journeyExactSha = await put(join(fixture.root, journeyPath), journey);
    const journeySha = digest(JSON.stringify(canonical(journey)));
    const manifestPath = ".taphound/journeys/flow-proofs/mail-open-detail.resolve.json";
    const unsignedManifest = {
      version: 1,
      source: { path: flowPath, sha256: flowSha },
      flows: [{
        name: flowName,
        path: flowPath,
        sha256: flowSha,
        stepCount: 1
      }],
      expansion: [flowName],
      journey: { name: flowName, sha256: journeySha, stepCount: 1 }
    };
    const manifestSha = await put(join(fixture.root, manifestPath), {
      ...unsignedManifest,
      resolutionSha256: digest(JSON.stringify(canonical(unsignedManifest)))
    });
    const reportPath = ".taphound/build/runs/flow-proof/report.json";
    const reportSha = await put(join(fixture.root, reportPath), validReport({
      runId: "flow-run",
      journey: { name: flowName, sha256: journeySha },
      fallbackUsed: false
    }));
    const flowInput = join(fixture.root, "flow-record.json");
    await put(flowInput, {
      version: 1,
      expectedRevision: 0,
      name: flowName,
      path: flowPath,
      sha256: flowSha,
      exitActivity: "com.example.DetailActivity",
      journey: { path: journeyPath, sha256: journeyExactSha },
      resolutionManifest: { path: manifestPath, sha256: manifestSha },
      report: { path: reportPath, sha256: reportSha }
    });
    expect(command(
      "record-flow", "--suite", fixture.suite, "--input", flowInput
    )).toMatchObject({
      code: 0,
      output: { status: "recorded", revision: 1 }
    });
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 1,
      caseId: "CASE-001",
      from: "pending",
      to: "briefing",
      reason: "Claim Case"
    })).toMatchObject({ code: 0 });
    await bindBrief(fixture, 2);
    expect(await transition(fixture.suite, fixture.root, {
      expectedRevision: 3,
      caseId: "CASE-001",
      from: "briefReady",
      to: "generating",
      reason: "Use verified Base Flow",
      generation: { id: "generation-1", baseFlow: flowName }
    })).toMatchObject({
      code: 0,
      output: { status: "transitioned", revision: 4 }
    });
  });
});
