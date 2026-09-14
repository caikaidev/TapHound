import { z } from "zod";

import {
  KnowledgeIdSchema,
  KnowledgeSha256Schema
} from "./knowledge.js";
import { EvidenceRequirementSchema } from "./contract.js";

export const PlaybookKindSchema = z.enum([
  "feature-acceptance",
  "bug-regression",
  "behavior-regression",
  "visual-parity"
]);

export const PlaybookPhaseSchema = z.enum([
  "repro-fail",
  "contract-verify",
  "baseline-capture",
  "change-apply",
  "replay-journey",
  "baseline-compare",
  "visual-compare",
  "evidence-collect",
  "verdict-apply"
]);

export const PlaybookInputSchema = z.strictObject({
  contractPath: z.string().trim().min(1),
  journeyPath: z.string().trim().min(1).optional(),
  baselinePath: z.string().trim().min(1).optional(),
  referenceImagePath: z.string().trim().min(1).optional()
});

export const PlaybookContractBindingSchema = z.strictObject({
  path: z.string().trim().min(1),
  sha256: KnowledgeSha256Schema
});

export const PlaybookDefinitionSchema = z.strictObject({
  version: z.literal(1),
  id: KnowledgeIdSchema,
  kind: PlaybookKindSchema,
  goal: z.string().trim().min(1),
  phases: z.array(PlaybookPhaseSchema).min(1).superRefine((phases, context) => {
    if (new Set(phases).size !== phases.length) {
      context.addIssue({
        code: "custom",
        message: "Playbook phases must be unique"
      });
    }
  }),
  contract: PlaybookContractBindingSchema,
  evidenceRequirements: z.array(EvidenceRequirementSchema).default([]),
  passCondition: z.string().trim().min(1),
  failCondition: z.string().trim().min(1),
  inconclusiveCondition: z.string().trim().min(1),
  escalation: z.lazy(() => EscalationPolicySchema)
});

export const EscalationWhenSchema = z.strictObject({
  verdicts: z.array(z.enum([
    "pass",
    "fail",
    "inconclusive",
    "needsReview",
    "invalid"
  ])).min(1).optional(),
  reasons: z.array(z.enum([
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
  ])).min(1).optional()
}).refine(
  (when) => when.verdicts !== undefined || when.reasons !== undefined,
  "An escalation condition needs at least one signal"
);

export const EscalationResultSchema = z.enum([
  "pass",
  "fail",
  "inconclusive",
  "needsReview",
  "invalid"
]);

export const EscalationTargetSchema = z.enum([
  "semantic",
  "multimodal"
]);

export const EscalationActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("verdict"),
    result: EscalationResultSchema
  }),
  z.strictObject({
    action: z.literal("escalate"),
    target: EscalationTargetSchema
  })
]);

export const EscalationRuleSchema = z.strictObject({
  id: KnowledgeIdSchema,
  when: EscalationWhenSchema,
  then: EscalationActionSchema
});

export const EscalationPolicySchema = z.strictObject({
  version: z.literal(1),
  rules: z.array(EscalationRuleSchema).min(1).superRefine((rules, context) => {
    const ids = new Set<string>();
    for (const [index, rule] of rules.entries()) {
      if (ids.has(rule.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `Escalation rule id "${rule.id}" appears more than once`
        });
      }
      ids.add(rule.id);
    }
  })
});

export type PlaybookKind = z.infer<typeof PlaybookKindSchema>;
export type PlaybookPhase = z.infer<typeof PlaybookPhaseSchema>;
export type PlaybookDefinition = z.infer<typeof PlaybookDefinitionSchema>;
export type EscalationWhen = z.infer<typeof EscalationWhenSchema>;
export type EscalationResult = z.infer<typeof EscalationResultSchema>;
export type EscalationTarget = z.infer<typeof EscalationTargetSchema>;
export type EscalationAction = z.infer<typeof EscalationActionSchema>;
export type EscalationRule = z.infer<typeof EscalationRuleSchema>;
export type EscalationPolicy = z.infer<typeof EscalationPolicySchema>;