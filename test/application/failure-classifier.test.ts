import { describe, expect, it } from "vitest";

import { FailureClassifier } from "../../src/application/diagnosis/failure-classifier.js";
import type { TapHoundReport } from "../../src/domain/report.js";

function report(overrides: Partial<TapHoundReport> = {}): TapHoundReport {
  return {
    schemaVersion: 4,
    runId: "run-1",
    status: "failed",
    startedAt: "2026-07-19T10:00:00.000Z",
    finishedAt: "2026-07-19T10:00:05.000Z",
    durationMs: 5000,
    project: {
      root: "/project",
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity"
    },
    journey: { name: "Search", sha256: "a".repeat(64) },
    layers: {
      run: "failed",
      structural: "failed",
      activityCheckpoint: "failed",
      explicitExpect: "failed",
      collection: "failed"
    },
    steps: [{
      index: 2,
      action: "click",
      status: "failed",
      startedAtMs: 0,
      finishedAtMs: 100,
      durationMs: 100,
      locator: {
        status: "failed",
        fallbackUsed: false,
        message: "search"
      }
    }],
    artifacts: {
      directory: "/runs/run-1",
      report: "/runs/run-1/report.json",
      summary: "/runs/run-1/summary.json",
      screenshots: [{ role: "default", path: "screenshot-default.png" }],
      logcats: [{ role: "default", path: "logcat-default.txt" }],
      stepLogs: ["steps/002.log"]
    },
    primaryFailure: {
      code: "LOCATOR_NOT_FOUND",
      message: "search target missing",
      phase: "replay",
      stepIndex: 2
    },
    secondaryErrors: [],
    fallbackUsed: false,
    environment: {
      devices: [{ role: "default", deviceSerial: "emulator-5554" }],
      tools: { adb: "1.0.41" }
    },
    ...overrides
  };
}

describe("FailureClassifier", () => {
  const classifier = new FailureClassifier({
    now: (): Date => new Date("2026-07-19T10:00:06.000Z")
  });

  it("classifies a LOCATOR_NOT_FOUND as target_not_found with evidence refs", () => {
    const result = classifier.classify({ report: report() });
    expect(result.type).toBe("target_not_found");
    expect(result.stage).toBe("interaction");
    expect(result.code).toBe("LOCATOR_NOT_FOUND");
    expect(result.stepIndex).toBe(2);
    expect(result.expected).toBe("search");
    expect(result.actual).toBe("not found in layout");
    expect(result.evidenceRefs).toContain("screenshot-default.png");
    expect(result.evidenceRefs).toContain("logcat-default.txt");
    expect(result.evidenceRefs).toContain("steps/002.log");
  });

  it("classifies ANCHOR_NOT_FOUND as target_unresolved", () => {
    const result = classifier.classify({ report: report({
      primaryFailure: {
        code: "ANCHOR_NOT_FOUND",
        message: "anchor search.open missing",
        phase: "replay",
        stepIndex: 0
      }
    }) });
    expect(result.type).toBe("target_unresolved");
  });

  it("classifies ACTIVITY_AFTER_MISMATCH with expected/actual", () => {
    const withActivity = report({
      primaryFailure: {
        code: "ACTIVITY_AFTER_MISMATCH",
        message: "after activity mismatch",
        phase: "replay",
        stepIndex: 1
      },
      steps: [{
        index: 1,
        action: "click",
        status: "failed",
        startedAtMs: 0,
        finishedAtMs: 100,
        durationMs: 100,
        activity: {
          before: {
            status: "passed",
            expected: "com.example.app.MainActivity",
            actual: "com.example.app.MainActivity"
          },
          after: {
            status: "failed",
            expected: "com.example.app.SearchActivity",
            actual: "com.example.app.LauncherActivity"
          }
        }
      }]
    });
    const result = classifier.classify({ report: withActivity });
    expect(result.type).toBe("activity_mismatch");
    expect(result.stage).toBe("navigation");
    expect(result.expected).toBe("com.example.app.SearchActivity");
    expect(result.actual).toBe("com.example.app.LauncherActivity");
  });

  it("classifies APP_CRASHED with process expectations", () => {
    const result = classifier.classify({ report: report({
      primaryFailure: {
        code: "APP_CRASHED",
        message: "process died",
        phase: "runtime"
      }
    }) });
    expect(result.type).toBe("app_crash");
    expect(result.stage).toBe("launch");
    expect(result.expected).toBe("process alive");
    expect(result.actual).toBe("process exited");
  });

  it("classifies a contract drift as contract_invalid", () => {
    const result = classifier.classify({ report: report({
      primaryFailure: {
        code: "CONTRACT_JOURNEY_DRIFT",
        message: "journey drifted",
        phase: "setup"
      }
    }) });
    expect(result.type).toBe("contract_invalid");
    expect(result.stage).toBe("setup");
    expect(result.expected).toBe("binding satisfied");
    expect(result.actual).toBe("journey drifted");
  });

  it("rejects a report without a primary failure", () => {
    expect(() => classifier.classify({
      report: report({ primaryFailure: undefined })
    })).toThrow(/no primary failure/);
  });
});