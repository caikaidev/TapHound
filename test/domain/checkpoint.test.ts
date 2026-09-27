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
    stepIndex: 0,
    kind: "present",
    matchedBy: "resourceId"
  }],
  screens: [{
    screen: "search",
    status: "matched"
  }],
  requiredEvidence: { screens: true },
  sourceReportPath: "/runs/run-1/report.json"
};

const validCheckpoint: CheckpointDefinition = {
  version: 1,
  id: "results-visible",
  name: "Search results visible",
  stepIndex: 3,
  expect: {
    allOf: [
      { kind: "activity", expected: "com.example.app.SearchActivity" },
      { kind: "visibleElement", locator: { resourceId: "results" } }
    ],
    timeoutMs: 100
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

  it("rejects a baseline without facts", () => {
    expect(BaselineSchema.safeParse({
      ...validBaseline,
      activities: [],
      elements: [],
      screens: []
    }).success).toBe(false);
  });

  it("allows Checkpoint-only facts and rejects duplicate condition identities", () => {
    const checkpoint = {
      checkpointId: "search-ready",
      stepIndex: 0,
      kind: "absentElement",
      locator: { resourceId: "loading" }
    };
    const only = {
      ...validBaseline,
      activities: [],
      elements: [],
      screens: [],
      checkpoints: [checkpoint]
    };
    expect(BaselineSchema.parse(only).checkpoints).toEqual([checkpoint]);
    expect(BaselineSchema.safeParse({
      ...only,
      checkpoints: [checkpoint, checkpoint]
    }).success).toBe(false);
  });

  it("rejects duplicate Screen facts", () => {
    expect(BaselineSchema.safeParse({
      ...validBaseline,
      screens: [validBaseline.screens[0], validBaseline.screens[0]]
    }).success).toBe(false);
  });

  it("requires exactly one stable element identity", () => {
    expect(BaselineSchema.safeParse({
      ...validBaseline,
      elements: [{ kind: "present" }]
    }).success).toBe(false);
  });

  it("rejects screen facts when Screen evidence is explicitly excluded", () => {
    expect(BaselineSchema.safeParse({
      ...validBaseline,
      requiredEvidence: { screens: false }
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
  it("disallows Capture or replay references in standalone Checkpoint conditions", () => {
    const base = {
      version: 1, id: "no-bindings", name: "Checkpoint",
      expect: { timeoutMs: 100, allOf: [{
        kind: "logcatEvent", expect: {
          type: "logcatEvent", tag: "Demo", event: "Ready",
          correlation: { key: "id", value: "${token}" }
        }
      }] }
    };
    expect(() => CheckpointDefinitionSchema.parse(base)).toThrow(/approved fields/);
    expect(() => CheckpointDefinitionSchema.parse({
      ...base,
      expect: {
        ...base.expect,
        allOf: [{
          kind: "logcatEvent",
          expect: {
            type: "logcatEvent", tag: "Demo", event: "Ready",
            capture: { name: "token", field: "id", valueType: "identifier" }
          }
        }]
      }
    })).toThrow(/cannot capture Replay bindings/);
  });

  it("accepts exclusive allOf conditions with a shared timeout and rejects duplicates", () => {
    const allOf = [{
      kind: "logcatEvent", expect: {
        type: "logcatEvent", tag: "Search", event: "results",
        window: { from: "marker", markerId: "start" }
      }
    }, { kind: "absentElement", locator: { resourceId: "spinner" } }];
    const checkpoint = { version: 1, id: "search-all", name: "Search all",
      expect: { timeoutMs: 300, allOf } };
    expect(CheckpointDefinitionSchema.parse(checkpoint).expect.allOf).toHaveLength(2);
    expect(CheckpointDefinitionSchema.safeParse({
      ...checkpoint, expect: { ...checkpoint.expect, activity: "SearchActivity" }
    }).success).toBe(false);
    expect(CheckpointDefinitionSchema.safeParse({
      ...checkpoint, expect: { ...checkpoint.expect, allOf: [allOf[0], allOf[0]] }
    }).success).toBe(false);
    expect(CheckpointDefinitionSchema.safeParse({
      ...checkpoint, expect: { allOf }
    }).success).toBe(false);
  });
  it("accepts a checkpoint with an activity expectation", () => {
    const parsed = CheckpointDefinitionSchema.parse(validCheckpoint);
    expect(parsed.expect.allOf).toContainEqual({
      kind: "activity",
      expected: "com.example.app.SearchActivity"
    });
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
      coverage: { activities: 1, elements: 0, screens: 0 },
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
      coverage: { activities: 1, elements: 0, screens: 0 },
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
      coverage: { activities: 1, elements: 0, screens: 0 },
      regressions: []
    }).success).toBe(false);
  });

  it("rejects empty coverage masquerading as equivalence", () => {
    expect(RegressionCompareResultSchema.safeParse({
      version: 1,
      baselineId: "search-baseline",
      journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:00.000Z",
      equivalent: true,
      coverage: { activities: 0, elements: 0, screens: 0 },
      regressions: []
    }).success).toBe(false);
  });

  it("allows equivalence with only Checkpoint condition coverage", () => {
    expect(RegressionCompareResultSchema.parse({
      version: 1,
      baselineId: "search-baseline",
      journeySha256: "a".repeat(64),
      comparedAt: "2026-07-19T10:00:00.000Z",
      equivalent: true,
      coverage: { activities: 0, elements: 0, screens: 0, checkpoints: 1 },
      regressions: []
    }).equivalent).toBe(true);
  });
});