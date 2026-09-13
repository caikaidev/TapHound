import { z } from "zod";

import {
  ContractVerdictReasonSchema,
  ContractVerdictSchema
} from "./contract.js";
import { KnowledgeIdSchema, KnowledgeSha256Schema } from "./knowledge.js";

export const FalseDoneCategorySchema = z.enum([
  "correct",
  "behavior",
  "visual",
  "boundary"
]);

export const FalseDoneDetectionSchema = z.enum([
  "confirmed",
  "missed",
  "falseReject",
  "detected",
  "error"
]);

export const FalseDoneCaseSchema = z.strictObject({
  version: z.literal(1),
  id: KnowledgeIdSchema,
  category: FalseDoneCategorySchema,
  description: z.string().trim().min(1),
  variant: z.strictObject({
    label: KnowledgeIdSchema,
    apkPath: z.string().trim().min(1)
  }),
  contractPath: z.string().trim().min(1),
  expectedVerdict: ContractVerdictSchema,
  tags: z.array(KnowledgeIdSchema).default([])
});

export const FalseDoneCaseResultSchema = z.strictObject({
  caseId: KnowledgeIdSchema,
  category: FalseDoneCategorySchema,
  variantLabel: KnowledgeIdSchema,
  apkSha256: KnowledgeSha256Schema,
  expectedVerdict: ContractVerdictSchema,
  actualVerdict: ContractVerdictSchema.optional(),
  detection: FalseDoneDetectionSchema,
  contractSha256: KnowledgeSha256Schema.optional(),
  verdictReason: ContractVerdictReasonSchema.optional(),
  reportStatus: z
    .enum(["passed", "failed", "error", "manualRequired"])
    .optional(),
  anchorUnresolved: z.number().int().nonnegative(),
  evidenceInsufficient: z.boolean().optional(),
  error: z.string().trim().min(1).optional(),
  attempts: z.number().int().positive(),
  stableAcrossAttempts: z.boolean().optional()
});

export const FalseDoneRunResultSchema = z.strictObject({
  version: z.literal(1),
  runId: KnowledgeIdSchema,
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  deviceSerial: z.string().trim().min(1),
  repeats: z.number().int().positive(),
  results: z.array(FalseDoneCaseResultSchema),
  metrics: z.strictObject({
    eligibleCases: z.number().int().nonnegative(),
    falseDoneExpected: z.number().int().nonnegative(),
    falseDoneDetected: z.number().int().nonnegative(),
    falseDoneRecall: z.number().min(0).max(1).nullable(),
    missedCount: z.number().int().nonnegative(),
    falseRejectCount: z.number().int().nonnegative(),
    falseRejectRate: z.number().min(0).max(1).nullable(),
    verdictAgreementRate: z.number().min(0).max(1).nullable(),
    errorCount: z.number().int().nonnegative(),
    replayStabilityRate: z.number().min(0).max(1).nullable(),
    anchorUnresolvedTotal: z.number().int().nonnegative(),
    evidenceInsufficientTotal: z.number().int().nonnegative()
  })
});

export type FalseDoneCategory = z.infer<typeof FalseDoneCategorySchema>;
export type FalseDoneDetection = z.infer<typeof FalseDoneDetectionSchema>;
export type FalseDoneCase = z.infer<typeof FalseDoneCaseSchema>;
export type FalseDoneCaseResult = z.infer<typeof FalseDoneCaseResultSchema>;
export type FalseDoneRunResult = z.infer<typeof FalseDoneRunResultSchema>;