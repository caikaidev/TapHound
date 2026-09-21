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
      screens: [{ screen: "search", status: "matched" }],
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
      screen: "search"
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
    requested: { resourceId: "com.example.app:id/search" },
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

  it("freezes only uniquely evidenced events and refuses incomplete comparison", () => {
    const run = passedResult([]);
    run.report.screens = [];
    run.hookOutcomes = [];
    const expectEvent = {
      type: "logcatEvent" as const, tag: "Search", event: "results",
      fields: { query: "hello" }, unique: true as const,
      window: { from: "runStart" as const }
    };
    run.report.checkpoints = [{
      id: "search-event", status: "passed",
      conditions: [{
        kind: "logcatEvent", status: "passed", expect: expectEvent,
        matchedCount: 1, matchedLineSha256: "f".repeat(64),
        startedAtMs: 10, matchedAtMs: 20, evidenceRef: "logcat-default.txt"
      }]
    }];
    const capture = (): ReturnType<BaselineCapturer["capture"]> => capturer.capture({
      id: "search-baseline", journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z", runId: "run-1",
      packageName: "com.example.app", result: run
    });
    const baseline = capture();
    expect(baseline.checkpoints).toEqual([{
      checkpointId: "search-event", kind: "logcatEvent", expect: expectEvent
    }]);
    const compare = (): ReturnType<typeof compareRegression> => compareRegression({
      baseline, current: run.report, journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:10.000Z"
    });
    expect(compare()).toMatchObject({ equivalent: true, coverage: { checkpoints: 1 } });
    run.report.logcatEvidence = [{
      role: "default", status: "incomplete",
      droppedLines: 1, droppedBytes: 10, lastDroppedAtMs: 5
    }];
    expect(compare()).toMatchObject({ equivalent: true });
    expect(capture().checkpoints).toHaveLength(1);
    run.report.logcatEvidence = [{
      role: "default", status: "incomplete",
      droppedLines: 1, droppedBytes: 10, lastDroppedAtMs: 10
    }];
    expect(compare).toThrow(/unresolved current evidence/);
    expect(capture).toThrow(/incomplete Logcat event evidence/);
    run.report.logcatEvidence = undefined;
    const checkpoint = run.report.checkpoints[0];
    if (checkpoint === undefined) throw new Error("Missing Checkpoint fixture");
    run.report.checkpoints = [{
      ...checkpoint, status: "failed",
      conditions: [{
        ...checkpoint.conditions[0], kind: "logcatEvent", expect: expectEvent,
        status: "failed", matchedCount: 0, startedAtMs: 10
      }]
    }];
    expect(compare()).toMatchObject({
      equivalent: false, regressions: [{ kind: "logcatEvent", actual: "failed" }]
    });
    run.report.checkpoints = [{
      ...checkpoint, status: "passed",
      conditions: [{
        kind: "logcatEvent", status: "passed", expect: expectEvent,
        matchedCount: 1, startedAtMs: 10
      }]
    }];
    expect(capture).toThrow(/incomplete Logcat event evidence/);
  });

  it("freezes passed activity, Screen, presence, and verified absence at a Checkpoint", () => {
    const run = passedResult([]);
    run.report.screens = [];
    run.hookOutcomes = [];
    run.report.checkpoints = [{
      id: "search-ready",
      status: "passed",
      conditions: [
        {
          kind: "activity", status: "passed",
          expected: "com.example.app.SearchActivity",
          actual: "com.example.app.SearchActivity"
        },
        { kind: "screen", status: "passed", expected: "search", actual: "search" },
        { kind: "visibleElement", status: "passed", locator: { resourceId: "search" } },
        { kind: "absentElement", status: "passed", locator: { resourceId: "loading" } }
      ]
    }];
    const baseline = capturer.capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: run
    });
    expect(baseline.checkpoints).toHaveLength(4);
    expect(baseline.checkpoints?.[3]).toEqual({
      checkpointId: "search-ready",
      kind: "absentElement",
      locator: { resourceId: "loading" }
    });
    const equivalent = compareRegression({
      baseline, current: run.report, journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:10.000Z"
    });
    expect(equivalent).toMatchObject({
      equivalent: true,
      coverage: { checkpoints: 4 }
    });
    const checkpoint = run.report.checkpoints[0];
    if (checkpoint === undefined) {
      throw new Error("Missing Checkpoint fixture");
    }
    run.report.checkpoints = [{
      ...checkpoint,
      status: "failed",
      conditions: checkpoint.conditions.map((condition) => (
        condition.kind === "absentElement"
          ? { ...condition, status: "failed" as const }
          : condition
      ))
    }];
    const drift = compareRegression({
      baseline, current: run.report, journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:10.000Z"
    });
    expect(drift).toMatchObject({
      equivalent: false,
      regressions: [{
        kind: "element",
        checkpointId: "search-ready",
        expected: "passed absentElement",
        actual: "failed"
      }]
    });
    run.report.checkpoints = [];
    expect(() => compareRegression({
      baseline, current: run.report, journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:10.000Z"
    })).toThrow(/no unique current evaluation/);
  });

  it("does not let another Checkpoint satisfy the same absent locator", () => {
    const run = passedResult(steps);
    const absent = {
      kind: "absentElement" as const,
      status: "passed" as const,
      locator: { resourceId: "loading" }
    };
    run.report.checkpoints = [
      { id: "first", stepIndex: 0, status: "passed", conditions: [absent] },
      { id: "last", status: "passed", conditions: [absent] }
    ];
    const baseline = capturer.capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: run
    });
    run.report.checkpoints = [
      { id: "first", stepIndex: 0, status: "failed", conditions: [{
        ...absent, status: "failed"
      }] },
      { id: "last", status: "passed", conditions: [absent] }
    ];
    expect(compareRegression({
      baseline, current: run.report, journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:10.000Z"
    }).regressions).toMatchObject([{
      checkpointId: "first",
      kind: "element",
      actual: "failed"
    }]);
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
    expect(baseline.elements[0]?.locator).toEqual({
      resourceId: "com.example.app:id/search"
    });
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

  it("refuses to infer absence from a failed locator", () => {
    const failed = passedResult([{
      ...steps[0],
      locator: {
        status: "failed",
        fallbackUsed: false,
        message: "not found"
      }
    }]);
    expect(() => capturer.capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: failed
    })).toThrow(/unverified locator/);
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

  it("refuses a locator without requested identity", () => {
    const report = passedResult([{
      ...steps[0],
      locator: {
        status: "found",
        matchedBy: "resourceId",
        fallbackUsed: false
      }
    }]);
    expect(() => capturer.capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: report
    })).toThrow(/no stable identity/);
  });

  it("refuses to freeze unresolved Screen results", () => {
    const report = passedResult(steps);
    report.report.screens = [{ screen: "search", status: "unresolved" }];
    expect(() => capturer.capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: report
    })).toThrow(/resolved Screen matches/);
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
    expect(result.coverage).toEqual({
      activities: 1,
      elements: 1,
      screens: 1
    });
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

  it("flags changed requested locator identity as a regression", () => {
    const baseline = new BaselineCapturer({ now: (): Date => new Date() }).capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: passedResult(steps)
    });
    const current = passedResult([{
      ...steps[0],
      locator: {
        ...steps[0]?.locator,
        status: "found",
        requested: { resourceId: "com.example.app:id/search-v2" },
        fallbackUsed: false
      }
    }]);

    const result = compareRegression({
      baseline,
      current: current.report,
      journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:10.000Z"
    });
    expect(result.regressions.some((diff) => diff.kind === "element")).toBe(true);
  });

  it("flags a missing structured Screen match as a regression", () => {
    const baseline = new BaselineCapturer({ now: (): Date => new Date() }).capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: passedResult(steps)
    });
    const current = passedResult(steps);
    current.report.screens = [];

    const result = compareRegression({
      baseline,
      current: current.report,
      journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:10.000Z"
    });
    expect(result.regressions.some((diff) => diff.kind === "screen")).toBe(true);
  });

  it("detects Screen status drift", () => {
    const baseline = new BaselineCapturer({ now: (): Date => new Date() }).capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: passedResult(steps)
    });
    const current = passedResult(steps);
    current.report.screens = [{ screen: "search", status: "ambiguous" }];
    const result = compareRegression({
      baseline,
      current: current.report,
      journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:10.000Z"
    });
    expect(result.regressions).toContainEqual({
      kind: "screen",
      screen: "search",
      expected: "matched",
      actual: "ambiguous"
    });
  });

  it("detects match method and annotated fallback drift", () => {
    const baseline = new BaselineCapturer({ now: (): Date => new Date() }).capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: passedResult(steps)
    });
    const current = passedResult([{
      ...steps[0],
      locator: {
        ...steps[0]?.locator,
        status: "found",
        matchedBy: "text",
        fallbackUsed: true,
        fallbackLabel: "#1",
        annotatedScreenshotPath: "fallback.png"
      }
    }]);
    const result = compareRegression({
      baseline,
      current: current.report,
      journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:10.000Z"
    });
    expect(result.regressions).toHaveLength(2);
    expect(result.regressions.map((diff) => diff.expected)).toEqual([
      "matched by resourceId",
      "annotated fallback false"
    ]);
  });

  it("does not let another step satisfy an element fact", () => {
    const baseline = new BaselineCapturer({ now: (): Date => new Date() }).capture({
      id: "search-baseline",
      journeySha256: "a".repeat(64),
      capturedAt: "2026-07-19T10:00:06.000Z",
      runId: "run-1",
      packageName: "com.example.app",
      result: passedResult(steps)
    });
    const current = passedResult([{
      ...steps[0],
      locator: undefined
    }, {
      ...steps[0],
      index: 1
    }]);
    const result = compareRegression({
      baseline,
      current: current.report,
      journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:10.000Z"
    });
    expect(result.regressions.some((diff) => (
      diff.kind === "element" && diff.stepIndex === 0
    ))).toBe(true);
  });
});