import { describe, expect, it } from "vitest";

import { DiagnosticsExporter } from "../../../src/application/diagnostics/diagnostics-exporter.js";
import type { CommandEvent } from "../../../src/domain/diagnostics.js";
import type { TapHoundReport } from "../../../src/domain/report.js";
import type { DiagnosticsJournal } from "../../../src/ports/diagnostics.js";
import { validReport } from "../../fixtures/report.js";

const ROOT = "/Users/alice/secret-bank-app";
const PACKAGE = "com.alice.secretbank";
const SECRET_TEXT = "Transfer 9,999 to Bob";

function event(overrides: Partial<CommandEvent> = {}): CommandEvent {
  return {
    version: 1,
    kind: "command",
    at: "2026-09-28T12:00:00.000Z",
    taphoundVersion: "0.2.0-dev.11",
    host: { platform: "darwin", arch: "arm64", node: "24.3.0" },
    command: "verify",
    flags: ["project", "journey", "json"],
    durationMs: 108000,
    exitCode: 1,
    status: "failed",
    failureCode: "LOCATOR_NOT_FOUND",
    ui: [],
    ...overrides
  };
}

function sensitiveReport(runId: string): TapHoundReport {
  const base = validReport();
  const step = base.steps[0];
  if (step === undefined) throw new Error("fixture step missing");
  return validReport({
    runId,
    status: "failed",
    project: {
      root: ROOT,
      packageName: PACKAGE,
      launchActivity: `${PACKAGE}.MainActivity`
    },
    journey: { name: "Checkout for VIP customers", sha256: "b".repeat(64) },
    environment: {
      devices: [{ role: "sender", deviceSerial: "R58M123SECRET" }],
      tools: { node: "24.3.0", adb: "1.0.41", android: "1.0.0", gradle: "8.9" }
    },
    steps: [{
      ...step,
      status: "failed",
      device: "sender",
      locator: {
        status: "failed",
        requested: { text: SECRET_TEXT },
        fallbackUsed: false,
        message: `No element matches text=${SECRET_TEXT}`
      },
      idle: {
        status: "stable",
        polls: 7,
        durationMs: 9800,
        samplingDurationMs: 3300,
        strategy: "hybrid",
        backend: "uiautomator",
        frameActivityDetected: false,
        lastDiff: [{ text: SECRET_TEXT }]
      },
      activity: {
        before: {
          status: "passed",
          expected: `${PACKAGE}.TransferActivity`,
          actual: `${PACKAGE}.TransferActivity`
        },
        after: { status: "notRun", expected: `${PACKAGE}.ConfirmActivity` }
      }
    }],
    primaryFailure: {
      code: "LOCATOR_NOT_FOUND",
      message: `No element matches text=${SECRET_TEXT} in ${ROOT}`,
      phase: "replay",
      stepIndex: 0
    },
    secondaryErrors: [{ code: "COLLECTION_FAILED", message: `${ROOT}/logcat`, phase: "collection" }],
    logcatEvidence: [{ role: "sender", status: "incomplete", droppedLines: 1883, droppedBytes: 274880 }],
    artifacts: {
      ...base.artifacts,
      directory: `${ROOT}/.taphound/build/runs/${runId}`,
      screenshots: [{ role: "sender", path: "screenshot-sender.png" }],
      logcats: [{ role: "sender", path: "logcat-sender.txt" }]
    }
  });
}

function exporter(lines: string[], files: Record<string, unknown>): DiagnosticsExporter {
  const journal: DiagnosticsJournal = {
    append: () => Promise.resolve(),
    readLines: () => Promise.resolve(lines),
    salt: () => Promise.resolve(Buffer.alloc(32, 7))
  };
  return new DiagnosticsExporter({
    journal,
    readJson: (path) => (path in files
      ? Promise.resolve(files[path])
      : Promise.reject(new Error(`missing ${path}`))),
    now: () => new Date("2026-09-28T13:00:00.000Z"),
    taphoundVersion: "0.2.0-dev.11",
    host: { platform: "darwin", arch: "arm64", node: "24.3.0" }
  });
}

const config = {
  version: 1,
  run: { packageName: PACKAGE, activity: ".MainActivity" },
  idle: { strategy: "hybrid", pollIntervalMs: 300, stablePolls: 3, timeoutMs: 15000 },
  ui: { backend: "appium-uiautomator2", snapshotTimeoutMs: 5000 },
  artifactsDir: ".taphound/build/runs"
};

describe("DiagnosticsExporter", () => {
  it("summarizes referenced runs with aliases and salted locator digests only", async () => {
    const runs = ["2026-09-28T12-00-00.000Z-a", "2026-09-28T12-05-00.000Z-b"];
    const bundle = await exporter(
      [
        JSON.stringify(event({ runId: runs[0] })),
        "{not json",
        JSON.stringify({ ...event(), command: `verify ${ROOT}` }),
        JSON.stringify(event({ runId: runs[1] }))
      ],
      {
        [`${ROOT}/.taphound/config.json`]: config,
        [`${ROOT}/.taphound/build/runs/${runs[0] ?? ""}/report.json`]: sensitiveReport(runs[0] ?? ""),
        [`${ROOT}/.taphound/build/runs/${runs[1] ?? ""}/report.json`]: sensitiveReport(runs[1] ?? "")
      }
    ).export({ projectRoot: ROOT, eventLimit: 50, runLimit: 10 });

    expect(bundle.journal.skippedLines).toBe(2);
    expect(bundle.journal.events.map((entry) => entry.runId)).toEqual(["run#1", "run#2"]);
    expect(bundle.config).toEqual({
      idle: { strategy: "hybrid", pollIntervalMs: 300, stablePolls: 3, timeoutMs: 15000, deviceProfiles: 0 },
      ui: { backend: "appium-uiautomator2", snapshotTimeoutMs: 5000 }
    });
    const [first, second] = bundle.runs;
    expect(first).toMatchObject({
      run: "run#1",
      status: "failed",
      journey: "journey#1",
      devices: [{ device: "device#1" }],
      tools: { node: "24.3.0", adb: "1.0.41", android: "1.0.0" },
      primaryFailure: { code: "LOCATOR_NOT_FOUND", phase: "replay", stepIndex: 0 },
      secondaryErrorCodes: ["COLLECTION_FAILED"],
      logcatEvidence: [{ device: "device#1", droppedLines: 1883, droppedBytes: 274880 }],
      steps: [{
        device: "device#1",
        locator: { status: "failed", requestedFields: ["text"], fallbackUsed: false },
        idle: { polls: 7, durationMs: 9800, samplingDurationMs: 3300, lastDiffCount: 1 },
        activity: {
          before: { expected: "activity#1", actual: "activity#1" },
          after: { status: "notRun", expected: "activity#2" }
        }
      }]
    });
    expect(first?.tools).not.toHaveProperty("gradle");
    const firstLocator = first?.steps[0]?.locator?.locatorId;
    expect(firstLocator).toMatch(/^[a-f\d]{16}$/);
    // The same locator keeps one digest, so repeated failures correlate.
    expect(second?.steps[0]?.locator?.locatorId).toBe(firstLocator);
    expect(second?.journey).toBe("journey#1");

    const text = JSON.stringify(bundle);
    for (const sensitive of [ROOT, PACKAGE, SECRET_TEXT, "VIP", "R58M123SECRET", "sender", "Transfer"]) {
      expect(text).not.toContain(sensitive);
    }
  });

  it("limits events and runs to the most recent and skips unreadable reports", async () => {
    const bundle = await exporter(
      ["a", "b", "c"].map((runId) => JSON.stringify(event({ runId }))),
      {
        [`${ROOT}/.taphound/build/runs/c/report.json`]: sensitiveReport("c"),
        [`${ROOT}/.taphound/build/runs/b/report.json`]: { schemaVersion: 3 }
      }
    ).export({ projectRoot: ROOT, eventLimit: 2, runLimit: 5 });

    expect(bundle.config).toBeUndefined();
    expect(bundle.journal.events.map((entry) => entry.runId)).toEqual(["run#1", "run#2"]);
    expect(bundle.runs.map((run) => run.run)).toEqual(["run#2"]);
  });
});
