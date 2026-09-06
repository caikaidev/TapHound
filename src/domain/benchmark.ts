import { z } from "zod";

import { KnowledgeIdSchema, KnowledgeSha256Schema } from "./knowledge.js";
import { GoalSpecSchema } from "./route.js";

export const BenchmarkCaseSchema = z.strictObject({
  version: z.literal(1),
  id: KnowledgeIdSchema,
  description: z.string().trim().min(1),
  goal: GoalSpecSchema,
  preconditions: z.array(z.string().trim().min(1)),
  tags: z.array(KnowledgeIdSchema).default([])
});

export const BenchmarkGroundTruthSchema = z.strictObject({
  version: z.literal(1),
  caseId: KnowledgeIdSchema,
  startScreen: KnowledgeIdSchema,
  targetScreen: KnowledgeIdSchema,
  routeTransitionIds: z.array(KnowledgeIdSchema),
  expectedOutcome: z.enum(["success", "noRoute"])
});

const BenchmarkTimingSchema = z.strictObject({
  recognitionMs: z.number().nonnegative(),
  planningMs: z.number().nonnegative(),
  actionResolutionMs: z.number().nonnegative(),
  executionMs: z.number().nonnegative(),
  totalMs: z.number().nonnegative()
});

export const BenchmarkCaseResultSchema = z.strictObject({
  caseId: KnowledgeIdSchema,
  status: z.enum(["passed", "failed", "invalid", "notRun"]),
  engine: z.enum(["legacy", "knowledge"]),
  routeCorrect: z.boolean().nullable(),
  firstRunSuccess: z.boolean().nullable(),
  recoveryCount: z.number().int().nonnegative(),
  llmCalls: z.number().int().nonnegative(),
  llmInputTokens: z.number().int().nonnegative(),
  llmOutputTokens: z.number().int().nonnegative(),
  timing: BenchmarkTimingSchema,
  failureCode: z.string().trim().min(1).optional(),
  detail: z.string().trim().min(1).optional()
});

export const BenchmarkRunResultSchema = z.strictObject({
  version: z.literal(1),
  runId: KnowledgeIdSchema,
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  knowledgeHash: KnowledgeSha256Schema.optional(),
  results: z.array(BenchmarkCaseResultSchema),
  metrics: z.strictObject({
    eligibleCases: z.number().int().nonnegative(),
    passedCases: z.number().int().nonnegative(),
    firstRunSuccessRate: z.number().min(0).max(1).nullable(),
    routeAccuracy: z.number().min(0).max(1).nullable(),
    averageRecognitionMs: z.number().nonnegative().nullable(),
    averagePlanningMs: z.number().nonnegative().nullable(),
    averageRecoveryCount: z.number().nonnegative().nullable(),
    totalLlmCalls: z.number().int().nonnegative(),
    totalLlmInputTokens: z.number().int().nonnegative(),
    totalLlmOutputTokens: z.number().int().nonnegative()
  })
});

export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;
export type BenchmarkGroundTruth = z.infer<typeof BenchmarkGroundTruthSchema>;
export type BenchmarkCaseResult = z.infer<typeof BenchmarkCaseResultSchema>;
export type BenchmarkRunResult = z.infer<typeof BenchmarkRunResultSchema>;
