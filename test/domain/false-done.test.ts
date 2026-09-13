import { describe, expect, it } from "vitest";

import {
  FalseDoneCaseSchema,
  FalseDoneRunResultSchema
} from "../../src/domain/false-done.js";

const validCase = {
  version: 1 as const,
  id: "fd-behavior-01",
  category: "behavior" as const,
  description: "Search result list stays empty after submit",
  variant: { label: "behavior-search-empty", apkPath: ".taphound/variants/behavior-01.apk" },
  contractPath: ".taphound/contracts/fd-behavior-01.json",
  expectedVerdict: "fail" as const,
  tags: ["search"]
};

describe("FalseDoneCaseSchema", () => {
  it("accepts a canonical false-done case", () => {
    const parsed = FalseDoneCaseSchema.parse(validCase);
    expect(parsed.id).toBe("fd-behavior-01");
    expect(parsed.expectedVerdict).toBe("fail");
  });

  it("rejects unknown fields", () => {
    expect(FalseDoneCaseSchema.safeParse({
      ...validCase,
      extra: true
    }).success).toBe(false);
  });

  it("accepts all four categories", () => {
    for (const category of ["correct", "behavior", "visual", "boundary"]) {
      expect(FalseDoneCaseSchema.safeParse({
        ...validCase,
        category
      }).success).toBe(true);
    }
  });
});

describe("FalseDoneRunResultSchema", () => {
  it("accepts a run result with metrics", () => {
    const result = {
      version: 1 as const,
      runId: "run-1",
      startedAt: "2026-09-13T10:00:00.000Z",
      completedAt: "2026-09-13T10:00:05.000Z",
      deviceSerial: "emulator-5554",
      repeats: 1,
      results: [{
        caseId: "fd-behavior-01",
        category: "behavior" as const,
        variantLabel: "behavior-search-empty",
        apkSha256: "a".repeat(64),
        expectedVerdict: "fail" as const,
        actualVerdict: "fail" as const,
        detection: "detected" as const,
        verdictReason: "RUN_FAILED" as const,
        anchorUnresolved: 0,
        attempts: 1
      }],
      metrics: {
        eligibleCases: 1,
        falseDoneExpected: 1,
        falseDoneDetected: 1,
        falseDoneRecall: 1,
        missedCount: 0,
        falseRejectCount: 0,
        falseRejectRate: null,
        verdictAgreementRate: 1,
        errorCount: 0,
        replayStabilityRate: null,
        anchorUnresolvedTotal: 0,
        evidenceInsufficientTotal: 0
      }
    };
    expect(FalseDoneRunResultSchema.parse(result).metrics.falseDoneRecall).toBe(1);
  });

  it("rejects an unknown detection value", () => {
    const result = {
      version: 1,
      runId: "run-1",
      startedAt: "2026-09-13T10:00:00.000Z",
      completedAt: "2026-09-13T10:00:05.000Z",
      deviceSerial: "emulator-5554",
      repeats: 1,
      results: [{
        caseId: "fd-behavior-01",
        category: "behavior",
        variantLabel: "v",
        apkSha256: "a".repeat(64),
        expectedVerdict: "fail",
        actualVerdict: "fail",
        detection: "bogus",
        anchorUnresolved: 0,
        attempts: 1
      }],
      metrics: {
        eligibleCases: 1,
        falseDoneExpected: 1,
        falseDoneDetected: 1,
        falseDoneRecall: 1,
        missedCount: 0,
        falseRejectCount: 0,
        falseRejectRate: null,
        verdictAgreementRate: 1,
        errorCount: 0,
        replayStabilityRate: null,
        anchorUnresolvedTotal: 0,
        evidenceInsufficientTotal: 0
      }
    };
    expect(FalseDoneRunResultSchema.safeParse(result).success).toBe(false);
  });
});