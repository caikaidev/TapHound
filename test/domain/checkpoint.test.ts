import { describe, expect, it } from "vitest";

import {
  BaselineSchema,
  CheckpointDefinitionSchema,
  RegressionCompareResultSchema,
  type Baseline,
  type CheckpointDefinition
} from "../../src/domain/checkpoint.js";

const validBaseline: Baseline = {
  version: 1,
  id: "search-baseline",
  journeySha256: "a".repeat(64),
  contractSha256: "b".repeat(64),
  capturedAt: "2026-07-19T10:00:00.000Z",
  packageName: "com.example.app",
  runId: "run-1",
  activities: [{
    stepIndex: 0,
    before: "com.example.app.MainActivity",
    after: "com.example.app.SearchActivity"
  }],
  elements: [{
    locator: { resourceId: "search" },
    kind: "present",
    matchedBy: "resourceId"
  }],
  screens: [{
    screen: "search",
    status: "matched"
  }],
  sourceReportPath: "/runs/run-1/report.json"
};

const validCheckpoint: CheckpointDefinition = {
  version: 1,
  id: "results-visible",
  name: "Search results visible",
  stepIndex: 3,
  expect: {
    activity: "com.example.app.SearchActivity",
    visibleElements: [{ resourceId: "results" }],
    absentElements: []
  },
  status: "inferred"
};

describe("BaselineSchema", () => {
  it("accepts a canonical baseline", () => {
    const parsed = BaselineSchema.parse(validBaseline);
    expect(parsed.journeySha256).toBe("a".repeat(64));
    expect(parsed.activities).toHaveLength(1);
    expect(parsed.elements[0]?.kind).toBe("present");
  });

  it("rejects duplicate activity step facts", () => {
    expect(BaselineSchema.safeParse({
      ...validBaseline,
      activities: [validBaseline.activities[0], validBaseline.activities[0]]
    }).success).toBe(false);
  });

  it("rejects duplicate element facts", () => {
    expect(BaselineSchema.safeParse({
      ...validBaseline,
      elements: [validBaseline.elements[0], validBaseline.elements[0]]
    }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(BaselineSchema.safeParse({
      ...validBaseline,
      extra: true
    }).success).toBe(false);
  });
});

describe("CheckpointDefinitionSchema", () => {
  it("accepts a checkpoint with an activity expectation", () => {
    const parsed = CheckpointDefinitionSchema.parse(validCheckpoint);
    expect(parsed.expect.activity).toBe("com.example.app.SearchActivity");
    expect(parsed.expect.visibleElements).toHaveLength(1);
  });

  it("defaults expect arrays to empty", () => {
    const parsed = CheckpointDefinitionSchema.parse({
      version: 1,
      id: "screen-only",
      name: "On search screen",
      expect: { screen: "search" }
    });
    expect(parsed.expect.visibleElements).toEqual([]);
    expect(parsed.expect.absentElements).toEqual([]);
  });

  it("rejects an empty expectation", () => {
    expect(CheckpointDefinitionSchema.safeParse({
      version: 1,
      id: "empty",
      name: "Empty",
      expect: {}
    }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(CheckpointDefinitionSchema.safeParse({
      ...validCheckpoint,
      extra: true
    }).success).toBe(false);
  });
});

describe("RegressionCompareResultSchema", () => {
  it("accepts an equivalent result", () => {
    const parsed = RegressionCompareResultSchema.parse({
      version: 1,
      baselineId: "search-baseline",
      journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:00.000Z",
      equivalent: true,
      regressions: []
    });
    expect(parsed.equivalent).toBe(true);
  });

  it("accepts a diff list", () => {
    const parsed = RegressionCompareResultSchema.parse({
      version: 1,
      baselineId: "search-baseline",
      journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:00.000Z",
      equivalent: false,
      regressions: [{
        kind: "activity",
        stepIndex: 0,
        expected: "before com.example.app.MainActivity",
        actual: "before com.example.app.LauncherActivity"
      }]
    });
    expect(parsed.regressions[0]?.kind).toBe("activity");
  });

  it("rejects a diff on an absent baseline id", () => {
    expect(RegressionCompareResultSchema.safeParse({
      version: 1,
      baselineId: "",
      journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:00.000Z",
      equivalent: false,
      regressions: []
    }).success).toBe(false);
  });
});