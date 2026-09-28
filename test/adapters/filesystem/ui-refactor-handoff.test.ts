import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { GenerationMetaSchema } from "../../../src/domain/generation.js";
import { JourneySchema } from "../../../src/domain/journey.js";
import { hashJourney } from "../../../src/domain/report.js";
import { validReport } from "../../fixtures/report.js";
import { TEST_UI_BACKEND } from "../../fakes/ui-backend.js";
import { contextSelection } from "../../fixtures/project-context.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const helper = join(repo, "assets/skills/taphound-verify-change/scripts/ui-refactor.mjs");
const sha = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
type Result = {
  status: string;
  handoff?: string;
  reason?: string;
  coverage?: { required: number; evidenced: number };
};
function run(...argv: string[]): { code: number; output: Result } {
  const result = spawnSync(process.execPath, [helper, ...argv], { encoding: "utf8" });
  return { code: result.status ?? -1, output: JSON.parse(result.stdout) as Result };
}
async function put(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
async function prepareFixture(): Promise<{
  base: string; target: string; shared: string; input: string;
  beforeReport: string; beforeReceipt: string; afterJourney: string;
  afterReport: string; afterReceipt: string;
}> {
  const base = await mkdtemp(join(repo, "test/fixtures/.ui-refactor-base-"));
  const target = await realpath(await mkdtemp(join(tmpdir(), "taphound-ui-target-")));
  const shared = await realpath(await mkdtemp(join(tmpdir(), "taphound-ui-shared-")));
  paths.push(base, target, shared);
  const casePath = join(base, "cases/forward.json");
  const beforeJourney = join(base, ".taphound/journeys/forward.json");
  const beforeMeta = beforeJourney.replace(/\.json$/, ".meta.json");
  const beforeReport = join(base, ".taphound/build/runs/run-before/report.json");
  const beforeReceipt = join(base, ".taphound/build/workflows/forward/receipt.json");
  const afterJourney = join(target, ".taphound/journeys/new-forward.json");
  const afterReport = join(target, ".taphound/build/runs/run-after/report.json");
  const afterReceipt = join(target, ".taphound/build/workflows/forward/receipt.json");
  const apk = join(base, "app.apk");
  const input = join(base, "ui-input.json");
  const expected = {
    type: "element", locator: { text: "Forward compose" }, timeoutMs: 1500
  };
  const checkpoints = [{
    version: 1, id: "forward-control", name: "Forward control is accessible",
    stepIndex: 0, expect: {
      allOf: [{
        kind: "visibleElement",
        locator: { contentDescription: "Forward message" }
      }],
      timeoutMs: 1500
    }
  }, {
    version: 1, id: "loading-finished", name: "Loading is gone",
    stepIndex: 0, expect: {
      allOf: [{ kind: "absentElement", locator: { text: "Loading" } }],
      timeoutMs: 1500
    }
  }, {
    version: 1, id: "forward-ready-event", name: "Forward business state is ready",
    stepIndex: 0, expect: {
      allOf: [{
        kind: "logcatEvent",
        expect: {
          type: "logcatEvent", tag: "MailState", event: "forwardReady",
          fields: { fixtureId: "fixture-email-001" },
          unique: true, window: { from: "runStart" }
        }
      }],
      timeoutMs: 1500
    }
  }];
  const old = JourneySchema.parse({
    version: 2, name: "before",
    devices: [{ role: "default" }],
    steps: [{
      action: "click", locator: { resourceId: "forward_old" },
      activity: {
        before: "com.example.app.MainActivity",
        after: "com.example.app.SearchActivity"
      },
      expect: expected
    }],
    checkpoints
  });
  const next = JourneySchema.parse({
    ...old, name: "after",
    steps: [{
      ...old.steps[0], locator: { resourceId: "forward_new" },
      activity: {
        before: "com.example.app.MainActivity",
        after: "com.example.app.SearchActivity"
      }
    }]
  });
  await put(casePath, {
    version: 1, caseId: "forward-preserve",
    sourceRef: "fixture-mail-forward",
    goal: "Forward an email with the same visible compose state",
    fixtureRef: "fixture-email-001",
    packageName: "com.example.app",
    scenario: ["Open fixture mail", "Tap Forward", "See Forward compose"],
    observables: [
      {
        id: "forward-compose", kind: "visibleText",
        afterAction: "click", text: "Forward compose", timeoutMs: 1500
      },
      {
        id: "forward-control", kind: "visibleElement",
        locator: { contentDescription: "Forward message" }, timeoutMs: 1500
      },
      {
        id: "loading-finished", kind: "absentElement",
        locator: { text: "Loading" }, timeoutMs: 1500
      },
      {
        id: "forward-ready-event", kind: "logcatEvent",
        expect: {
          type: "logcatEvent", tag: "MailState", event: "forwardReady",
          fields: { fixtureId: "fixture-email-001" },
          unique: true, window: { from: "runStart" }
        },
        timeoutMs: 1500
      }
    ]
  });
  await put(beforeJourney, old);
  await put(afterJourney, next);
  const makeMeta = (journey: typeof old, path: string): unknown =>
    GenerationMetaSchema.parse({
      version: 1, status: "verified", generationId: "generation-1",
      journeyPath: path, journeySha256: hashJourney(journey),
      bindings: {
        projectHash: "a".repeat(64),
        configHash: "b".repeat(64),
        contextHash: "c".repeat(64),
        uiBackend: TEST_UI_BACKEND
      },
      verification: {
        reportPath: "verification/report.json", reportSha256: "d".repeat(64),
        runId: "generation-run", runs: 1
      },
      manualOverrideStepIndexes: [],
      replayPolicy: {
        generatedReplayPolicy: true, requireFocusedInput: true,
        idle: { strategy: "structural", pollIntervalMs: 200, stablePolls: 2, timeoutMs: 5000 }
      },
      contextSelection,
      externalFlows: []
    });
  await put(beforeMeta, makeMeta(old, ".taphound/journeys/forward.json"));
  await put(afterJourney.replace(/\.json$/, ".meta.json"),
    makeMeta(next, ".taphound/journeys/new-forward.json"));
  const originalStep = validReport().steps[0];
  if (originalStep === undefined) throw new Error("Fixture report is missing its step");
  const makeReport = (root: string, journey: typeof old, path: string, runId: string): unknown =>
    validReport({
      runId,
      project: {
        root, packageName: "com.example.app",
        launchActivity: "com.example.app.MainActivity"
      },
      journey: { name: journey.name, sha256: hashJourney(journey) },
      steps: [{
        ...originalStep,
        locator: {
          status: "found",
          requested: { resourceId: journey.name === "before" ? "forward_old" : "forward_new" },
          matchedBy: "resourceId", fallbackUsed: false
        }
      }],
      checkpoints: [{
        id: "forward-control", stepIndex: 0, status: "passed",
        conditions: [{
          kind: "visibleElement", status: "passed",
          locator: { contentDescription: "Forward message" },
          startedAtMs: 300, matchedAtMs: 310, evidenceRef: "ui.xml"
        }]
      }, {
        id: "loading-finished", stepIndex: 0, status: "passed",
        conditions: [{
          kind: "absentElement", status: "passed",
          locator: { text: "Loading" },
          startedAtMs: 310, matchedAtMs: 320, evidenceRef: "ui.xml"
        }]
      }, {
        id: "forward-ready-event", stepIndex: 0, status: "passed",
        conditions: [{
          kind: "logcatEvent", status: "passed",
          expect: {
            type: "logcatEvent", tag: "MailState", event: "forwardReady",
            fields: { fixtureId: "fixture-email-001" },
            unique: true, window: { from: "runStart" }
          },
          matchedCount: 1, matchedLineSha256: "e".repeat(64),
          startedAtMs: 0, matchedAtMs: 325, evidenceRef: "logcat.txt"
        }]
      }],
      artifacts: {
        directory: dirname(path), report: "report.json", summary: "summary.txt",
        screenshots: [], logcats: [], stepLogs: []
      }
    });
  await put(beforeReport, makeReport(base, old, beforeReport, "run-before"));
  await put(afterReport, makeReport(target, next, afterReport, "run-after"));
  const receipt = async (journey: string, report: string, project: string): Promise<unknown> => ({
    version: 1,
    argv: ["verify", "--project", project, "--journey", journey,
      "--device", "emulator-5554", "--policy-from-meta", "--json"],
    exitCode: 0, journeySha256: hashJourney(await readJson(journey)),
    reportPath: report, reportSha256: sha(await readFile(report, "utf8"))
  });
  await put(beforeReceipt, await receipt(beforeJourney, beforeReport, base));
  await put(afterReceipt, await receipt(afterJourney, afterReport, target));
  await put(join(target, ".taphound/config.json"), {
    version: 1, run: { packageName: "com.example.app", activity: ".MainActivity" }
  });
  await writeFile(apk, "old-app-fixture");
  await put(input, {
    version: 1, caseId: "forward-preserve", casePath,
    base: {
      projectRoot: base, packageName: "com.example.app",
      deviceSerial: "emulator-5554", apkPath: apk,
      apkSha256: sha("old-app-fixture")
    },
    before: {
      journeyPath: beforeJourney, metaPath: beforeMeta,
      reportPath: beforeReport, receiptPath: beforeReceipt
    }
  });
  return {
    base, target, shared, input,
    beforeReport, beforeReceipt, afterJourney, afterReport, afterReceipt
  };
}
async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
async function rebindTarget(
  fixture: Awaited<ReturnType<typeof prepareFixture>>
): Promise<void> {
  const journey = await readJson(fixture.afterJourney) as {
    name: string;
  };
  const journeySha256 = hashJourney(journey);
  const metaPath = fixture.afterJourney.replace(/\.json$/, ".meta.json");
  const meta = await readJson(metaPath) as { journeySha256: string };
  meta.journeySha256 = journeySha256;
  await put(metaPath, meta);
  const report = await readJson(fixture.afterReport) as {
    journey: { name: string; sha256: string };
  };
  report.journey = { name: journey.name, sha256: journeySha256 };
  await put(fixture.afterReport, report);
  const receipt = await readJson(fixture.afterReceipt) as {
    journeySha256: string; reportSha256: string;
  };
  receipt.journeySha256 = journeySha256;
  receipt.reportSha256 = sha(await readFile(fixture.afterReport, "utf8"));
  await put(fixture.afterReceipt, receipt);
}
function published(input: string, shared: string): string {
  const result = run("prepare", "--input", input, "--out", shared);
  expect(result.code, JSON.stringify(result.output)).toBe(0);
  return result.output.handoff ?? "";
}
function compare(handoff: string, fixture: Awaited<ReturnType<typeof prepareFixture>>): {
  code: number; output: Result;
} {
  return run("compare", "--handoff", handoff, "--project", fixture.target,
    "--journey", fixture.afterJourney, "--report", fixture.afterReport,
    "--receipt", fixture.afterReceipt);
}

describe("cross-version UI-refactor Preserve gate", () => {
  it("covers XML-to-Compose changed IDs with stable semantics and business evidence", async () => {
    const fixture = await prepareFixture();
    const handoff = published(fixture.input, fixture.shared);
    await expect(readFile(join(dirname(handoff), "before-journey.json"))).resolves.toBeDefined();
    expect(run("validate", "--handoff", handoff, "--project", fixture.target))
      .toMatchObject({ code: 0, output: { status: "READY" } });
    expect(compare(handoff, fixture))
      .toMatchObject({ code: 0, output: {
        status: "PASS", coverage: { required: 4, evidenced: 4 }
      } });
  });

  it("pauses without real before-process attestation, missing observable, or target receipt", async () => {
    const fixture = await prepareFixture();
    await rm(fixture.beforeReceipt);
    expect(run("prepare", "--input", fixture.input, "--out", fixture.shared).code).toBe(2);
    const second = await prepareFixture();
    const handoff = published(second.input, second.shared);
    await rm(second.afterReceipt);
    expect(compare(handoff, second).code).toBe(2);
    const third = await prepareFixture();
    const thirdHandoff = published(third.input, third.shared);
    const journey = await readJson(third.afterJourney) as {
      steps: Array<{ expect: { locator: { text: string } } }>;
    };
    const first = journey.steps[0];
    if (first === undefined) throw new Error("Target fixture is missing its step");
    first.expect.locator.text = "not the frozen observable";
    await put(third.afterJourney, journey);
    await rebindTarget(third);
    expect(compare(thirdHandoff, third).code).toBe(2);
    const fourth = await prepareFixture();
    const fourthHandoff = published(fourth.input, fourth.shared);
    const fourthJourney = await readJson(fourth.afterJourney) as {
      checkpoints: Array<{ id: string; expect: {
        allOf: Array<{ locator?: { contentDescription?: string } }>;
      } }>;
    };
    const semantic = fourthJourney.checkpoints.find(
      (checkpoint) => checkpoint.id === "forward-control"
    );
    if (semantic?.expect.allOf[0]?.locator === undefined) {
      throw new Error("Semantic Checkpoint fixture is missing");
    }
    semantic.expect.allOf[0].locator.contentDescription = "Different semantics";
    await put(fourth.afterJourney, fourthJourney);
    await rebindTarget(fourth);
    expect(compare(fourthHandoff, fourth).code).toBe(2);
    const fifth = await prepareFixture();
    const fifthHandoff = published(fifth.input, fifth.shared);
    const fifthReport = await readJson(fifth.afterReport) as {
      checkpoints: Array<{
        id: string;
        conditions: Array<{ matchedLineSha256?: string }>;
      }>;
    };
    const event = fifthReport.checkpoints.find(
      (checkpoint) => checkpoint.id === "forward-ready-event"
    );
    if (event?.conditions[0] === undefined) {
      throw new Error("Structured event report fixture is missing");
    }
    delete event.conditions[0].matchedLineSha256;
    await put(fifth.afterReport, fifthReport);
    const fifthReceipt = await readJson(fifth.afterReceipt) as {
      reportSha256: string;
    };
    fifthReceipt.reportSha256 = sha(await readFile(fifth.afterReport, "utf8"));
    await put(fifth.afterReceipt, fifthReceipt);
    expect(compare(fifthHandoff, fifth).code).toBe(2);
  });

  it("reports FAIL for a bound independent failed Replay, not equivalence", async () => {
    const fixture = await prepareFixture();
    const handoff = published(fixture.input, fixture.shared);
    const report = await readJson(fixture.afterReport) as {
      status: string; steps: Array<{ status: string; expectation: { status: string } }>;
    };
    const step = report.steps[0];
    if (step === undefined) throw new Error("Target report is missing its step");
    report.status = "failed";
    step.status = "failed";
    step.expectation.status = "failed";
    Object.assign(report, {
      primaryFailure: {
        code: "EXPECT_ELEMENT_FAILED", phase: "expectation",
        message: "Forward compose is missing", stepIndex: 0
      },
      layers: { ...validReport().layers, run: "failed", explicitExpect: "failed" }
    });
    await put(fixture.afterReport, report);
    const receipt = await readJson(fixture.afterReceipt) as {
      reportSha256: string; exitCode: number;
    };
    receipt.exitCode = 1;
    receipt.reportSha256 = sha(await readFile(fixture.afterReport, "utf8"));
    await put(fixture.afterReceipt, receipt);
    // A matching failed strict Replay is a regression, never a PASS.
    expect(compare(handoff, fixture))
      .toMatchObject({ code: 1, output: {
        status: "FAIL", coverage: { required: 4, evidenced: 3 }
      } });
  });

  it("pauses on changed handoff artifacts, wrong target package, and symlink target", async () => {
    const fixture = await prepareFixture();
    const handoff = published(fixture.input, fixture.shared);
    await writeFile(join(dirname(handoff), "case.json"), "{}");
    expect(run("validate", "--handoff", handoff).code).toBe(2);
    const other = await prepareFixture();
    const md = published(other.input, other.shared);
    await put(join(other.target, ".taphound/config.json"), {
      run: { packageName: "com.other.app" }
    });
    expect(run("validate", "--handoff", md, "--project", other.target).code).toBe(2);
    const third = await prepareFixture();
    const thirdMd = published(third.input, third.shared);
    const meta = third.afterJourney.replace(/\.json$/, ".meta.json");
    const content = await readFile(meta);
    await rm(meta);
    await writeFile(join(third.target, "alias-meta.json"), content);
    await symlink(join(third.target, "alias-meta.json"), meta);
    expect(compare(thirdMd, third).code).toBe(2);
  });
});
