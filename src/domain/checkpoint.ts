import { z } from "zod";

import {
  KnowledgeIdSchema,
  KnowledgeSha256Schema,
  KnowledgeStatusSchema
} from "./knowledge.js";
import { QualifiedNameSchema } from "./knowledge.js";
import { LocatorSchema } from "./layout.js";

/**
 * Checkpoint: a named behavioral expectation at a point in a Journey.
 *
 * A Checkpoint is not a screenshot. It is a verifiable contract over
 * observable behavior: which Activity is in the foreground, which elements
 * are present/absent, and (optionally) a Knowledge Screen. The expectation is
 * deterministic and machine-checkable; a checkpoint never triggers an AI
 * layer by itself (see docs/source-of-truth.md).
 */
export const CheckpointExpectSchema = z.strictObject({
  activity: z.string().trim().min(1).optional(),
  screen: KnowledgeIdSchema.optional(),
  visibleElements: z.array(LocatorSchema).default([]),
  absentElements: z.array(LocatorSchema).default([])
}).refine(
  (expect) => (
    expect.activity !== undefined
    || expect.screen !== undefined
    || expect.visibleElements.length > 0
    || expect.absentElements.length > 0
  ),
  "A Checkpoint expectation needs at least one condition"
);

export const CheckpointDefinitionSchema = z.strictObject({
  version: z.literal(1),
  id: KnowledgeIdSchema,
  name: z.string().trim().min(1),
  stepIndex: z.number().int().nonnegative().optional(),
  expect: CheckpointExpectSchema,
  status: KnowledgeStatusSchema.default("inferred")
});

export const BaselineElementFactSchema = z.strictObject({
  locator: LocatorSchema,
  kind: z.enum(["present", "absent"]),
  matchedBy: z.enum([
    "resourceId",
    "text",
    "contentDescription",
    "anchor"
  ]).optional(),
  evidenceSha256: KnowledgeSha256Schema.optional()
});

export const BaselineActivityFactSchema = z.strictObject({
  stepIndex: z.number().int().nonnegative(),
  before: z.string().trim().min(1),
  after: z.string().trim().min(1)
});

export const BaselineScreenFactSchema = z.strictObject({
  screen: KnowledgeIdSchema,
  status: z.enum(["matched", "ambiguous", "unresolved"])
});

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
  sourceReportPath: z.string().trim().min(1)
}).superRefine((baseline, context) => {
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
    const key = JSON.stringify(fact.locator);
    if (elementKeys.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["elements", index, "locator"],
        message: "Element facts must be unique per locator"
      });
    }
    elementKeys.add(key);
  }
});

export function baselineEvidence(baseline: Baseline): BaselineEvidence {
  return {
    activities: baseline.activities,
    elements: baseline.elements,
    screens: baseline.screens
  };
}

export interface BaselineEvidence {
  activities: Baseline["activities"];
  elements: Baseline["elements"];
  screens: Baseline["screens"];
}

export type CheckpointExpect = z.infer<typeof CheckpointExpectSchema>;
export type CheckpointDefinition = z.infer<typeof CheckpointDefinitionSchema>;
export type BaselineElementFact = z.infer<
  typeof BaselineElementFactSchema
>;
export type BaselineActivityFact = z.infer<
  typeof BaselineActivityFactSchema
>;
export type BaselineScreenFact = z.infer<typeof BaselineScreenFactSchema>;
export type Baseline = z.infer<typeof BaselineSchema>;

/**
 * Regression compare result. `regressions` is empty when current evidence is
 * equivalent to the baseline; each entry names one drifted fact.
 */
export const RegressionDiffSchema = z.strictObject({
  kind: z.enum(["activity", "element", "screen"]),
  stepIndex: z.number().int().nonnegative().optional(),
  locator: LocatorSchema.optional(),
  expected: z.string().trim().min(1),
  actual: z.string().trim().min(1)
});

export const RegressionCompareResultSchema = z.strictObject({
  version: z.literal(1),
  baselineId: KnowledgeIdSchema,
  journeySha256: KnowledgeSha256Schema,
  comparedAt: z.iso.datetime(),
  equivalent: z.boolean(),
  regressions: z.array(RegressionDiffSchema)
});

export type RegressionDiff = z.infer<typeof RegressionDiffSchema>;
export type RegressionCompareResult = z.infer<
  typeof RegressionCompareResultSchema
>;