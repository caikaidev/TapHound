import { z } from "zod";

import {
  AnchorDefinitionSchema,
  KnowledgeIdSchema,
  KnowledgeSha256Schema,
  ScreenDefinitionSchema,
  TransitionDefinitionSchema
} from "./knowledge.js";

const ReceiptHeader = {
  version: z.literal(1),
  id: KnowledgeIdSchema,
  recordedAt: z.iso.datetime(),
  knowledgeHash: KnowledgeSha256Schema,
  snapshotHash: KnowledgeSha256Schema
};

const AnchorEvidenceSchema = z.strictObject({
  anchorId: KnowledgeIdSchema,
  result: z.enum(["matched", "missing", "ambiguous", "unknown"]),
  detail: z.string().trim().min(1).optional()
});

export const ScreenDetectionReceiptSchema = z.strictObject({
  ...ReceiptHeader,
  kind: z.literal("screenDetection"),
  result: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("matched"),
      screenId: KnowledgeIdSchema,
      evidence: z.array(AnchorEvidenceSchema)
    }),
    z.strictObject({
      status: z.literal("ambiguous"),
      screenIds: z.array(KnowledgeIdSchema).min(2),
      evidence: z.array(AnchorEvidenceSchema)
    }),
    z.strictObject({
      status: z.literal("unknown"),
      evidence: z.array(AnchorEvidenceSchema)
    })
  ])
});

export const AnchorResolutionReceiptSchema = z.strictObject({
  ...ReceiptHeader,
  kind: z.literal("anchorResolution"),
  anchorId: KnowledgeIdSchema,
  result: z.enum(["matched", "missing", "ambiguous", "unknown"]),
  matchedElementId: z.string().trim().min(1).optional()
});

export const TransitionVerificationReceiptSchema = z.strictObject({
  ...ReceiptHeader,
  kind: z.literal("transitionVerification"),
  transitionId: KnowledgeIdSchema,
  expectedScreen: KnowledgeIdSchema,
  actualScreen: KnowledgeIdSchema.optional(),
  result: z.enum(["verified", "deviated", "unknown"])
});

export const ReplanReceiptSchema = z.strictObject({
  ...ReceiptHeader,
  kind: z.literal("replan"),
  goalId: KnowledgeIdSchema,
  previousRouteHash: KnowledgeSha256Schema,
  nextRouteHash: KnowledgeSha256Schema,
  reason: z.enum(["transitionDeviation", "screenChanged"]),
  remainingBudget: z.number().int().nonnegative()
});

export const KnowledgeReceiptSchema = z.discriminatedUnion("kind", [
  ScreenDetectionReceiptSchema,
  AnchorResolutionReceiptSchema,
  TransitionVerificationReceiptSchema,
  ReplanReceiptSchema
]);

export const KnowledgePromotionSchema = z.strictObject({
  version: z.literal(1),
  expectedKnowledgeHash: KnowledgeSha256Schema,
  reason: z.string().trim().min(1),
  receiptIds: z.array(KnowledgeIdSchema).min(1),
  anchors: z.array(AnchorDefinitionSchema),
  screens: z.array(ScreenDefinitionSchema),
  transitions: z.array(TransitionDefinitionSchema)
}).superRefine((promotion, context) => {
  if (new Set(promotion.receiptIds).size !== promotion.receiptIds.length) {
    context.addIssue({
      code: "custom",
      path: ["receiptIds"],
      message: "Promotion receipt ids must be unique"
    });
  }
});

export type ScreenDetectionReceipt = z.infer<
  typeof ScreenDetectionReceiptSchema
>;
export type AnchorResolutionReceipt = z.infer<
  typeof AnchorResolutionReceiptSchema
>;
export type TransitionVerificationReceipt = z.infer<
  typeof TransitionVerificationReceiptSchema
>;
export type KnowledgeReceipt = z.infer<typeof KnowledgeReceiptSchema>;
export type KnowledgePromotion = z.infer<typeof KnowledgePromotionSchema>;
