import { z } from "zod";

import {
  KnowledgeIdSchema,
  KnowledgeSha256Schema,
  KnowledgeStatusSchema
} from "./knowledge.js";
import { QualifiedNameSchema } from "./knowledge.js";
import { LocatorSchema } from "./layout.js";
import { LogcatEventExpectSchema } from "./logcat-event.js";
import { checkBindingReferences } from "./binding-reference.js";

/**
 * Checkpoint: a named behavioral expectation at a point in a Journey.
 *
 * A Checkpoint is not a screenshot. It is a verifiable contract over
 * observable behavior: which Activity is in the foreground, which elements
 * are present/absent, and (optionally) a Knowledge Screen. The expectation is
 * deterministic and machine-checkable; a checkpoint never triggers an AI
 * layer by itself (see docs/source-of-truth.md).
 */
export const CheckpointAllOfConditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("activity"),
    expected: z.string().trim().min(1)
  }),
  z.strictObject({
    kind: z.literal("screen"),
    expected: KnowledgeIdSchema
  }),
  z.strictObject({
    kind: z.literal("visibleElement"),
    locator: LocatorSchema
  }),
  z.strictObject({
    kind: z.literal("absentElement"),
    locator: LocatorSchema
  }),
  z.strictObject({
    kind: z.literal("logcatEvent"),
    expect: LogcatEventExpectSchema.omit({ timeoutMs: true })
  })
]);

export const CheckpointExpectSchema = z.strictObject({
  activity: z.string().trim().min(1).optional(),
  screen: KnowledgeIdSchema.optional(),
  visibleElements: z.array(LocatorSchema).default([]),
  absentElements: z.array(LocatorSchema).default([]),
  allOf: z.array(CheckpointAllOfConditionSchema).min(1).optional(),
  timeoutMs: z.number().int().positive().max(60000).optional()
}).superRefine((expect, context) => {
  checkBindingReferences(expect, context, []);
  const hasLegacy = expect.activity !== undefined
    || expect.screen !== undefined
    || expect.visibleElements.length > 0
    || expect.absentElements.length > 0;
  if (expect.allOf === undefined && !hasLegacy) {
    context.addIssue({
      code: "custom",
      message: "A Checkpoint expectation needs at least one condition"
    });
  }
  if (expect.allOf !== undefined && (hasLegacy || expect.timeoutMs === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["allOf"],
      message: "allOf needs a shared timeoutMs and cannot mix with legacy conditions"
    });
  }
  if (expect.allOf === undefined && expect.timeoutMs !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["timeoutMs"],
      message: "timeoutMs is only supported with allOf"
    });
  }
  const keys = new Set<string>();
  const kinds = new Set<string>();
  for (const [index, condition] of (expect.allOf ?? []).entries()) {
    if (condition.kind === "logcatEvent" && condition.expect.capture !== undefined) {
      context.addIssue({
        code: "custom", path: ["allOf", index, "expect", "capture"],
        message: "Checkpoint cannot capture Replay bindings"
      });
    }
    if ((condition.kind === "activity" || condition.kind === "screen")
      && kinds.has(condition.kind)) {
      context.addIssue({
        code: "custom",
        path: ["allOf", index],
        message: "allOf supports only one activity and one screen condition"
      });
    }
    kinds.add(condition.kind);
    const key = JSON.stringify([
      condition.kind,
      condition.kind === "logcatEvent"
        ? condition.expect
        : "locator" in condition ? condition.locator : condition.expected
    ]);
    if (keys.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["allOf", index],
        message: "allOf conditions must have unique identities"
      });
    }
    keys.add(key);
  }
});

export const CheckpointDefinitionSchema = z.strictObject({
  version: z.literal(1),
  id: KnowledgeIdSchema,
  name: z.string().trim().min(1),
  /** Zero-based step index evaluated after that step; absent means after the Journey. */
  stepIndex: z.number().int().nonnegative().optional(),
  expect: CheckpointExpectSchema,
  status: KnowledgeStatusSchema.default("inferred")
});

export const BaselineElementFactSchema = z.strictObject({
  locator: LocatorSchema.optional(),
  anchorId: KnowledgeIdSchema.optional(),
  stepIndex: z.number().int().nonnegative().optional(),
  kind: z.enum(["present", "absent"]),
  matchedBy: z.enum([
    "resourceId",
    "text",
    "contentDescription",
    "anchor"
  ]).optional(),
  fallbackUsed: z.boolean().optional(),
  evidenceSha256: KnowledgeSha256Schema.optional()
}).refine(
  (fact) => (fact.locator === undefined) !== (fact.anchorId === undefined),
  "Element facts need exactly one locator or anchor identity"
);

export const BaselineActivityFactSchema = z.strictObject({
  stepIndex: z.number().int().nonnegative(),
  before: z.string().trim().min(1),
  after: z.string().trim().min(1)
});

export const BaselineScreenFactSchema = z.strictObject({
  screen: KnowledgeIdSchema,
  status: z.enum(["matched", "ambiguous", "unresolved"])
});

const CheckpointFactIdentity = {
  checkpointId: KnowledgeIdSchema,
  stepIndex: z.number().int().nonnegative().optional()
};

export const BaselineCheckpointFactSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...CheckpointFactIdentity,
    kind: z.literal("activity"),
    expected: z.string().trim().min(1)
  }),
  z.strictObject({
    ...CheckpointFactIdentity,
    kind: z.literal("screen"),
    expected: KnowledgeIdSchema
  }),
  z.strictObject({
    ...CheckpointFactIdentity,
    kind: z.literal("visibleElement"),
    locator: LocatorSchema
  }),
  z.strictObject({
    ...CheckpointFactIdentity,
    kind: z.literal("absentElement"),
    locator: LocatorSchema
  }),
  z.strictObject({
    ...CheckpointFactIdentity,
    kind: z.literal("logcatEvent"),
    expect: LogcatEventExpectSchema.omit({ timeoutMs: true })
  })
]);

/**
 * Baseline: frozen, hash-bound evidence of one known-good run.
 *
 * The Baseline is behavior evidence, not a screenshot (architecture doc
 * §15): activity sequence, element presence facts, optional Knowledge screen
 * detection, and the failing evidence summary fields. Every fact is
 * deterministic and comparable.
 */
export const BaselineSchema = z.strictObject({
  version: z.literal(1),
  id: KnowledgeIdSchema,
  journeySha256: KnowledgeSha256Schema,
  contractSha256: KnowledgeSha256Schema.optional(),
  capturedAt: z.iso.datetime(),
  packageName: QualifiedNameSchema,
  runId: z.string().trim().min(1),
  activities: z.array(BaselineActivityFactSchema),
  elements: z.array(BaselineElementFactSchema),
  screens: z.array(BaselineScreenFactSchema),
  checkpoints: z.array(BaselineCheckpointFactSchema).optional(),
  requiredEvidence: z.strictObject({
    screens: z.boolean()
  }).optional(),
  sourceReportPath: z.string().trim().min(1)
}).superRefine((baseline, context) => {
  if (
    baseline.activities.length === 0
    && baseline.elements.length === 0
    && baseline.screens.length === 0
    && (baseline.checkpoints?.length ?? 0) === 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["activities"],
      message: "A Baseline needs at least one comparable fact"
    });
  }
  if (
    baseline.requiredEvidence?.screens === false
    && baseline.screens.length > 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["requiredEvidence", "screens"],
      message: "Screen facts require Screen evidence"
    });
  }
  const steps = new Set<number>();
  for (const [index, fact] of baseline.activities.entries()) {
    if (steps.has(fact.stepIndex)) {
      context.addIssue({
        code: "custom",
        path: ["activities", index, "stepIndex"],
        message: `Activity facts must be unique per step; duplicate step ${String(fact.stepIndex)}`
      });
    }
    steps.add(fact.stepIndex);
  }
  const elementKeys = new Set<string>();
  for (const [index, fact] of baseline.elements.entries()) {
    const key = JSON.stringify([
      fact.stepIndex ?? null,
      fact.anchorId ?? null,
      fact.locator ?? null
    ]);
    if (elementKeys.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["elements", index],
        message: "Element facts must be unique per step and identity"
      });
    }
    elementKeys.add(key);
  }
  const screenIds = new Set<string>();
  for (const [index, fact] of baseline.screens.entries()) {
    if (screenIds.has(fact.screen)) {
      context.addIssue({
        code: "custom",
        path: ["screens", index, "screen"],
        message: "Screen facts must be unique per Screen"
      });
    }
    screenIds.add(fact.screen);
  }
  const checkpointKeys = new Set<string>();
  const checkpointPoints = new Map<string, number | undefined>();
  for (const [index, fact] of (baseline.checkpoints ?? []).entries()) {
    const priorPoint = checkpointPoints.get(fact.checkpointId);
    if (
      checkpointPoints.has(fact.checkpointId)
      && priorPoint !== fact.stepIndex
    ) {
      context.addIssue({
        code: "custom",
        path: ["checkpoints", index],
        message: "Checkpoint facts must share one evaluation point per ID"
      });
    }
    checkpointPoints.set(fact.checkpointId, fact.stepIndex);
    const key = JSON.stringify([
      fact.checkpointId,
      fact.stepIndex ?? null,
      fact.kind,
      "locator" in fact ? fact.locator
        : "expect" in fact ? fact.expect : fact.expected
    ]);
    if (checkpointKeys.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["checkpoints", index],
        message: "Checkpoint facts must have unique condition identities"
      });
    }
    checkpointKeys.add(key);
  }
});

export function baselineEvidence(baseline: Baseline): BaselineEvidence {
  return {
    activities: baseline.activities,
    elements: baseline.elements,
    screens: baseline.screens,
    ...(baseline.checkpoints === undefined ? {} : { checkpoints: baseline.checkpoints })
  };
}

export interface BaselineEvidence {
  activities: Baseline["activities"];
  elements: Baseline["elements"];
  screens: Baseline["screens"];
  checkpoints?: Baseline["checkpoints"];
}

export type CheckpointExpect = z.infer<typeof CheckpointExpectSchema>;
export type CheckpointAllOfCondition = z.infer<typeof CheckpointAllOfConditionSchema>;
export type CheckpointDefinition = z.infer<typeof CheckpointDefinitionSchema>;
export type BaselineElementFact = z.infer<
  typeof BaselineElementFactSchema
>;
export type BaselineActivityFact = z.infer<
  typeof BaselineActivityFactSchema
>;
export type BaselineScreenFact = z.infer<typeof BaselineScreenFactSchema>;
export type BaselineCheckpointFact = z.infer<typeof BaselineCheckpointFactSchema>;
export type Baseline = z.infer<typeof BaselineSchema>;

/**
 * Regression compare result. `regressions` is empty when current evidence is
 * equivalent to the baseline; each entry names one drifted fact.
 */
export const RegressionDiffSchema = z.strictObject({
  kind: z.enum(["activity", "element", "screen", "logcatEvent"]),
  stepIndex: z.number().int().nonnegative().optional(),
  locator: LocatorSchema.optional(),
  screen: KnowledgeIdSchema.optional(),
  checkpointId: KnowledgeIdSchema.optional(),
  expected: z.string().trim().min(1),
  actual: z.string().trim().min(1)
});

export const RegressionCompareResultSchema = z.strictObject({
  version: z.literal(1),
  baselineId: KnowledgeIdSchema,
  journeySha256: KnowledgeSha256Schema,
  comparedAt: z.iso.datetime(),
  equivalent: z.boolean(),
  coverage: z.strictObject({
    activities: z.number().int().nonnegative(),
    elements: z.number().int().nonnegative(),
    screens: z.number().int().nonnegative(),
    checkpoints: z.number().int().nonnegative().optional()
  }),
  regressions: z.array(RegressionDiffSchema)
}).superRefine((result, context) => {
  if (
    result.equivalent
    && (
      result.regressions.length > 0
      || (result.coverage.activities
        + result.coverage.elements
        + result.coverage.screens === 0
        && (result.coverage.checkpoints ?? 0) === 0)
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Equivalence requires nonempty coverage and no regressions"
    });
  }
});

export type RegressionDiff = z.infer<typeof RegressionDiffSchema>;
export type RegressionCompareResult = z.infer<
  typeof RegressionCompareResultSchema
>;