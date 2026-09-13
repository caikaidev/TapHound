import { describe, expect, it } from "vitest";

import { compareFalseDoneRuns } from "../../src/application/benchmark/false-done-compare.js";
import type { FalseDoneRunResult } from "../../src/domain/false-done.js";

function run(overrides: Partial<FalseDoneRunResult>): FalseDoneRunResult {
  return {
    version: 1,
    runId: "run-1",
    startedAt: "2026-09-13T10:00:00.000Z",
    completedAt: "2026-09-13T10:00:05.000Z",
    deviceSerial: "emulator-5554",
    repeats: 1,
    results: [],
    metrics: {
      eligibleCases: 0,
      falseDoneExpected: 0,
      falseDoneDetected: 0,
      falseDoneRecall: null,
      missedCount: 0,
      falseRejectCount: 0,
      falseRejectRate: null,
      verdictAgreementRate: null,
      errorCount: 0,
      replayStabilityRate: null,
      anchorUnresolvedTotal: 0,
      evidenceInsufficientTotal: 0
    },
    ...overrides
  };
}

function metrics(
  overrides: Partial<FalseDoneRunResult["metrics"]>
): FalseDoneRunResult["metrics"] {
  const base = {
    eligibleCases: 5,
    falseDoneExpected: 3,
    falseDoneDetected: 3,
    falseDoneRecall: 1,
    missedCount: 0,
    falseRejectCount: 0,
    falseRejectRate: 0,
    verdictAgreementRate: 1,
    errorCount: 0,
    replayStabilityRate: 1,
    anchorUnresolvedTotal: 0,
    evidenceInsufficientTotal: 0
  };
  return { ...base, ...overrides };
}

describe("compareFalseDoneRuns", () => {
  it("reports metric deltas between baseline and candidate", () => {
    const baseline = run({
      runId: "baseline",
      metrics: metrics({
        falseDoneRecall: 0.666,
        falseRejectRate: 0.5,
        replayStabilityRate: 1
      })
    });
    const candidate = run({
      runId: "candidate",
      metrics: metrics({
        falseDoneRecall: 1,
        falseRejectRate: 0,
        replayStabilityRate: 1
      })
    });
    const compared = compareFalseDoneRuns(baseline, candidate);
    expect(compared.metrics.falseDoneRecall.delta ?? 0).toBeCloseTo(0.334, 3);
    expect(compared.metrics.falseRejectRate).toEqual({
      baseline: 0.5,
      candidate: 0,
      delta: -0.5
    });
    expect(compared.metrics.replayStabilityRate.delta).toBe(0);
  });

  it("keeps null deltas when either side is null", () => {
    const baseline = run({
      runId: "baseline",
      metrics: metrics({ replayStabilityRate: null })
    });
    const candidate = run({
      runId: "candidate",
      metrics: metrics({ replayStabilityRate: 0.8 })
    });
    const compared = compareFalseDoneRuns(baseline, candidate);
    expect(compared.metrics.replayStabilityRate).toEqual({
      baseline: null,
      candidate: 0.8,
      delta: null
    });
  });

  it("flags per-case detection changes across runs", () => {
    const baseline = run({
      runId: "baseline",
      results: [{
        caseId: "behavior-01",
        category: "behavior",
        variantLabel: "v1",
        apkSha256: "a".repeat(64),
        expectedVerdict: "fail",
        actualVerdict: "pass",
        detection: "missed",
        anchorUnresolved: 0,
        attempts: 1
      }]
    });
    const candidate = run({
      runId: "candidate",
      results: [{
        caseId: "behavior-01",
        category: "behavior",
        variantLabel: "v1",
        apkSha256: "a".repeat(64),
        expectedVerdict: "fail",
        actualVerdict: "fail",
        detection: "detected",
        anchorUnresolved: 0,
        attempts: 1
      }]
    });
    const compared = compareFalseDoneRuns(baseline, candidate);
    expect(compared.caseDeltas).toEqual([{
      caseId: "behavior-01",
      baselineDetection: "missed",
      candidateDetection: "detected",
      changed: true
    }]);
  });
});