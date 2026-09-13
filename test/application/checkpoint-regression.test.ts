import { describe, expect, it } from "vitest";

import { BaselineCapturer } from "../../src/application/checkpoint/baseline-capturer.js";
import { compareRegression } from "../../src/application/checkpoint/regression-comparator.js";
import type { StepReport } from "../../src/domain/report.js";
import type { VerifyResult } from "../../src/application/runtime/verify-runtime.js";

type Step = StepReport;

function passedResult(reportSteps: unknown[]): VerifyResult {
  return {
    status: "passed",
    exitCode: 0,
    report: {
      schemaVersion: 4,
      runId: "run-1",
      status: "passed",
      startedAt: "2026-07-19T10:00:00.000Z",
      finishedAt: "2026-07-19T10:00:05.000Z",
      durationMs: 5000,
      project: {
        root: "/project",
        packageName: "com.example.app",
        launchActivity: "com.example.app.MainActivity"
      },
      journey: {
        name: "Search",
        sha256: "a".repeat(64)
      },
      layers: {
        run: "passed",
        structural: "passed",
        activityCheckpoint: "passed",
        explicitExpect: "passed",
        collection: "passed"
      },
      steps: reportSteps as VerifyResult["report"]["steps"],
      artifacts: {
        directory: "/runs/run-1",
        report: "report.json",
        summary: "summary.json",
        screenshots: [],
        logcats: [],
        stepLogs: []
      },
      primaryFailure: undefined,
      secondaryErrors: [],
      fallbackUsed: false,
      environment: {
        devices: [{
          role: "default",
          deviceSerial: "emulator-5554"
        }],
        tools: { adb: "1.0.41" }
      }
    },
    reportPath: "/runs/run-1/report.json",
    summaryPath: "/runs/run-1/summary.json",
    hookOutcomes: [{
      phase: "afterSteps",
      status: "passed",
      deviceRole: "default",
      message: "Expected screen search"
    }]
  };
}

const steps: VerifyResult["report"]["steps"] = [{
  index: 0,
  action: "click",
  status: "passed",
  startedAtMs: 0,
  finishedAtMs: 100,
  durationMs: 100,
  locator: {
    status: "found",
    matchedBy: "resourceId",
    fallbackUsed: false,
    message: "search"
  },
  activity: {
    before: { status: "passed", expected: "com.example.app.MainActivity", actual: "com.example.app.MainActivity" },
    after: { status: "passed", expected: "com.example.app.SearchActivity", actual: "com.example.app.SearchActivity" }
  }
}];

describe("BaselineCapturer", () => {
  const capturer = new BaselineCapturer({
    now: (): Date => new Date("2026-07-19T10:00:06.000Z")
  });

  it("captures activity and element facts from a passed report", () => {
    const baseline = capturer.capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: passedResult(steps)
    });
    expect(baseline.activities).toEqual([{
      stepIndex: 0,
      before: "com.example.app.MainActivity",
      after: "com.example.app.SearchActivity"
    }]);
    expect(baseline.elements[0]?.kind).toBe("present");
    expect(baseline.elements[0]?.matchedBy).toBe("resourceId");
  });

  it("extracts a screen fact from after-hook outcome", () => {
    const baseline = capturer.capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: passedResult(steps)
    });
    expect(baseline.screens).toEqual([{ screen: "search", status: "matched" }]);
  });

  it("records absent facts for failed locators", () => {
    const failed = passedResult([{
      ...steps[0],
      locator: {
        status: "failed",
        fallbackUsed: false,
        message: "not found"
      }
    }]);
    const baseline = capturer.capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: failed
    });
    expect(baseline.elements[0]?.kind).toBe("absent");
  });

  it("rejects a non-passed run", () => {
    const failedResult = {
      ...passedResult(steps),
      status: "failed" as const
    };
    expect(() => capturer.capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: failedResult
    })).toThrow(/requires a passed run/);
  });
});

describe("compareRegression", () => {
  it("reports equivalent when all facts reproduce", () => {
    const baseline = new BaselineCapturer({ now: (): Date => new Date() }).capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: passedResult(steps)
    });
    const result = compareRegression({
      baseline,
      current: passedResult(steps).report,
      journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:10.000Z"
    });
    expect(result.equivalent).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it("flags a changed after-activity as a regression", () => {
    const baseline = new BaselineCapturer({ now: (): Date => new Date() }).capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: passedResult(steps)
    });
    const first = steps[0] as Step;
    const drifted = passedResult([{
      ...first,
      activity: {
        before: first.activity?.before,
        after: {
          status: "passed",
          expected: "com.example.app.SearchActivity",
          actual: "com.example.app.ResultsActivity"
        }
      }
    }]);
    const result = compareRegression({
      baseline,
      current: drifted.report,
      journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:10.000Z"
    });
    expect(result.equivalent).toBe(false);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]?.expected).toContain("after com.example.app.SearchActivity");
  });

  it("flags a missing element as a regression", () => {
    const baseline = new BaselineCapturer({ now: (): Date => new Date() }).capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: passedResult(steps)
    });
    const first = steps[0] as Step;
    const broken = passedResult([{
      ...first,
      locator: {
        status: "failed",
        fallbackUsed: false,
        message: "search"
      }
    }]);
    const result = compareRegression({
      baseline,
      current: broken.report,
      journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:10.000Z"
    });
    expect(result.equivalent).toBe(false);
    expect(result.regressions.some((diff) => diff.kind === "element")).toBe(true);
  });
});