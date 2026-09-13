import { z } from "zod";

import { KnowledgeIdSchema, KnowledgeSha256Schema } from "./knowledge.js";
import { LocatorSchema } from "./layout.js";
import { ProjectRelativePathSchema } from "./project-context.js";

const QualifiedActivitySchema = z.string().regex(
  /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/,
  "Activity must be fully qualified"
);

const TimeoutMsSchema = z.number().int().positive();

export const ContractPreconditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("installed")
  }),
  z.strictObject({
    kind: z.literal("activity"),
    activity: QualifiedActivitySchema,
    timeoutMs: TimeoutMsSchema
  }),
  z.strictObject({
    kind: z.literal("screen"),
    screen: KnowledgeIdSchema,
    timeoutMs: TimeoutMsSchema
  }),
  z.strictObject({
    kind: z.literal("anchor"),
    anchor: KnowledgeIdSchema,
    timeoutMs: TimeoutMsSchema
  })
]);

export const ContractAssertionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("activity"),
    activity: QualifiedActivitySchema,
    timeoutMs: TimeoutMsSchema
  }),
  z.strictObject({
    type: z.literal("element"),
    locator: LocatorSchema,
    visibility: z.enum(["visible", "absent"]).default("visible"),
    packageName: QualifiedActivitySchema.optional(),
    timeoutMs: TimeoutMsSchema
  }),
  z.strictObject({
    type: z.literal("screen"),
    screen: KnowledgeIdSchema,
    timeoutMs: TimeoutMsSchema
  })
]);

export const EvidenceRequirementSchema = z.strictObject({
  kind: z.enum(["screenshot", "uiHierarchy", "logcat"]),
  scope: z.enum(["final", "anyStep"]).default("final"),
  required: z.boolean().default(true)
});

export const ContractJourneyBindingSchema = z.strictObject({
  path: ProjectRelativePathSchema,
  sha256: KnowledgeSha256Schema
});

export const AcceptanceContractSchema = z.strictObject({
  version: z.literal(1),
  id: KnowledgeIdSchema,
  goal: z.string().trim().min(1),
  targetScreen: KnowledgeIdSchema.optional(),
  journey: ContractJourneyBindingSchema,
  preconditions: z.array(ContractPreconditionSchema).default([]),
  assertions: z.array(ContractAssertionSchema).min(1),
  evidenceRequirements: z.array(EvidenceRequirementSchema).default([])
}).superRefine((contract, context) => {
  const preconditionKinds = new Set<string>();
  for (const [index, precondition] of contract.preconditions.entries()) {
    if (preconditionKinds.has(precondition.kind)) {
      context.addIssue({
        code: "custom",
        path: ["preconditions", index, "kind"],
        message: `Precondition kind "${precondition.kind}" appears more than once`
      });
    }
    preconditionKinds.add(precondition.kind);
  }
  const evidenceKeys = new Set<string>();
  for (const [index, requirement] of contract.evidenceRequirements.entries()) {
    const key = `${requirement.kind}:${requirement.scope}`;
    if (evidenceKeys.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["evidenceRequirements", index],
        message: `Evidence requirement "${key}" appears more than once`
      });
    }
    evidenceKeys.add(key);
  }
});

export const ContractVerdictSchema = z.enum([
  "pass",
  "fail",
  "inconclusive",
  "needsReview",
  "invalid"
]);

export const ContractVerdictReasonSchema = z.enum([
  "CONTRACT_OK",
  "RUN_FAILED",
  "RUN_ERROR",
  "RUN_MANUAL_REQUIRED",
  "PRECONDITION_FAILED",
  "PRECONDITION_UNRESOLVED",
  "ASSERTION_FAILED",
  "ASSERTION_UNRESOLVED",
  "EVIDENCE_INSUFFICIENT",
  "REVIEW_FINDINGS",
  "JOURNEY_DRIFT",
  "JOURNEY_MISSING",
  "KNOWLEDGE_UNAVAILABLE",
  "CONTRACT_INVALID"
]);

export const CONTRACT_VERDICT_POLICY_VERSION = "1";

export const ContractReviewFindingSchema = z.strictObject({
  finding: z.string().trim().min(1),
  region: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1),
  confidence: z.number().min(0).max(1),
  recommendedAction: z.enum(["review", "fix"]).default("review")
});

export const ContractReviewInputSchema = z.strictObject({
  version: z.literal(1),
  source: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  promptVersion: z.string().trim().min(1).optional(),
  findings: z.array(ContractReviewFindingSchema).min(1)
});

export const ContractReviewSchema = ContractReviewInputSchema.extend({
  appliedAt: z.iso.datetime(),
  applied: z.boolean(),
  baseVerdict: ContractVerdictSchema,
  baseReason: ContractVerdictReasonSchema
}).strict();

export const ContractProvenanceSchema = z.strictObject({
  policyVersion: z.string().trim().min(1),
  taphoundVersion: z.string().trim().min(1).optional(),
  toolVersions: z.record(z.string(), z.string()).optional()
});

export const ContractPreconditionOutcomeSchema = z.strictObject({
  kind: z.enum(["installed", "activity", "screen", "anchor"]),
  status: z.enum(["passed", "failed", "unresolved", "notRun"]),
  message: z.string().trim().min(1).optional()
});

export const ContractAssertionOutcomeSchema = z.strictObject({
  type: z.enum(["activity", "element", "screen"]),
  status: z.enum(["passed", "failed", "unresolved", "notRun"]),
  message: z.string().trim().min(1).optional()
});

export const ContractEvidenceOutcomeSchema = z.strictObject({
  kind: z.enum(["screenshot", "uiHierarchy", "logcat"]),
  required: z.boolean(),
  satisfied: z.boolean(),
  detail: z.string().trim().min(1).optional()
});

export const ContractVerdictViewSchema = z.strictObject({
  version: z.literal(1),
  contractId: z.string().trim().min(1),
  contractSha256: KnowledgeSha256Schema,
  journeySha256: KnowledgeSha256Schema,
  verdict: ContractVerdictSchema,
  reason: ContractVerdictReasonSchema,
  message: z.string().trim().min(1),
  preconditions: z.array(ContractPreconditionOutcomeSchema),
  assertions: z.array(ContractAssertionOutcomeSchema),
  evidence: z.array(ContractEvidenceOutcomeSchema),
  reportPath: z.string().trim().min(1).optional(),
  reportStatus: z.enum(["passed", "failed", "error", "manualRequired"]).optional(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  environment: z.strictObject({
    projectRoot: z.string().trim().min(1),
    packageName: z.string().trim().min(1),
    devices: z.array(z.string().trim().min(1)).min(1)
  }),
  provenance: ContractProvenanceSchema.optional(),
  review: ContractReviewSchema.optional()
});

export type ContractPrecondition = z.infer<typeof ContractPreconditionSchema>;
export type ContractAssertion = z.infer<typeof ContractAssertionSchema>;
export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;
export type AcceptanceContract = z.infer<typeof AcceptanceContractSchema>;
export type ContractVerdict = z.infer<typeof ContractVerdictSchema>;
export type ContractVerdictReason = z.infer<typeof ContractVerdictReasonSchema>;
export type ContractReviewFinding = z.infer<
  typeof ContractReviewFindingSchema
>;
export type ContractReviewInput = z.infer<typeof ContractReviewInputSchema>;
export type ContractReview = z.infer<typeof ContractReviewSchema>;
export type ContractProvenance = z.infer<typeof ContractProvenanceSchema>;
export type ContractPreconditionOutcome = z.infer<
  typeof ContractPreconditionOutcomeSchema
>;
export type ContractAssertionOutcome = z.infer<
  typeof ContractAssertionOutcomeSchema
>;
export type ContractEvidenceOutcome = z.infer<
  typeof ContractEvidenceOutcomeSchema
>;
export type ContractVerdictView = z.infer<typeof ContractVerdictViewSchema>;