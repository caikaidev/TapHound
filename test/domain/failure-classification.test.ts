import { describe, expect, it } from "vitest";

import {
  FAILURE_CODE_TYPES,
  FAILURE_TYPE_STAGES,
  FailureClassificationSchema,
  STEP_INDEXED_FAILURE_TYPES,
  type FailureClassification
} from "../../src/domain/failure-classification.js";
import { FAILURE_CODES } from "../../src/domain/failure.js";

const valid: FailureClassification = {
  version: 1,
  runId: "run-1",
  classificationId: "run-1:LOCATOR_NOT_FOUND:2",
  type: "target_not_found",
  stage: "interaction",
  code: "LOCATOR_NOT_FOUND",
  message: "target missing",
  stepIndex: 2,
  expected: "search",
  actual: "not found in layout",
  locator: { resourceId: "search" },
  evidenceRefs: ["screenshot-default.png"],
  sourceReportPath: "report.json"
};

describe("FailureClassificationSchema", () => {
  it("accepts a canonical classification", () => {
    const parsed = FailureClassificationSchema.parse(valid);
    expect(parsed.type).toBe("target_not_found");
    expect(parsed.stage).toBe("interaction");
    expect(parsed.evidenceRefs).toEqual(["screenshot-default.png"]);
  });

  it("defaults evidenceRefs to empty", () => {
    const { evidenceRefs: _omitted, ...rest } = valid;
    void _omitted;
    const parsed = FailureClassificationSchema.parse(rest);
    expect(parsed.evidenceRefs).toEqual([]);
  });

  it("rejects unknown fields", () => {
    expect(FailureClassificationSchema.safeParse({
      ...valid,
      extra: true
    }).success).toBe(false);
  });

  it("rejects an unknown failure type", () => {
    expect(FailureClassificationSchema.safeParse({
      ...valid,
      type: "made-up"
    }).success).toBe(false);
  });

  it("rejects a code outside the failure code universe", () => {
    expect(FailureClassificationSchema.safeParse({
      ...valid,
      code: "NOT_A_CODE"
    }).success).toBe(false);
  });
});

describe("failure taxonomy maps", () => {
  it("covers every failure code", () => {
    const codes = Object.keys(FAILURE_CODE_TYPES);
    expect(codes.sort()).toEqual([...FAILURE_CODES].sort());
    for (const code of codes) {
      const type = FAILURE_CODE_TYPES[code];
      expect(type).toBeDefined();
      const stage = type === undefined ? undefined : FAILURE_TYPE_STAGES[type];
      expect(stage).toBeDefined();
    }
  });

  it("maps Checkpoint failures to the assertion stage", () => {
    expect(FAILURE_CODE_TYPES.CHECKPOINT_FAILED).toBe("checkpoint_failed");
    expect(FAILURE_CODE_TYPES.CHECKPOINT_UNRESOLVED).toBe("checkpoint_failed");
    expect(FAILURE_TYPE_STAGES.checkpoint_failed).toBe("assertion");
  });

  it("classifies the anchor families distinctly", () => {
    expect(FAILURE_CODE_TYPES.ANCHOR_NOT_FOUND).toBe("target_unresolved");
    expect(FAILURE_CODE_TYPES.ANCHOR_AMBIGUOUS).toBe("target_ambiguous");
    expect(FAILURE_CODE_TYPES.RUNTIME_CAPABILITY_MISSING).toBe("capability_missing");
  });

  it("keeps step-indexed families narrow", () => {
    expect(STEP_INDEXED_FAILURE_TYPES.has("target_not_found")).toBe(true);
    expect(STEP_INDEXED_FAILURE_TYPES.has("environment_missing")).toBe(false);
    expect(STEP_INDEXED_FAILURE_TYPES.has("evidence_failed")).toBe(false);
  });
});