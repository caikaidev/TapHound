import { z } from "zod";

import {
  AnchorRoleSchema,
  KnowledgeIdSchema,
  KnowledgeSha256Schema,
  KnowledgeStatusSchema,
  QualifiedNameSchema
} from "./knowledge.js";

export const FeatureMapFeatureSchema = z.strictObject({
  id: KnowledgeIdSchema,
  screens: z.array(KnowledgeIdSchema).min(1),
  transitions: z.array(KnowledgeIdSchema).default([]),
  anchors: z.array(KnowledgeIdSchema).default([])
});

export const FeatureMapScreenEntrySchema = z.strictObject({
  id: KnowledgeIdSchema,
  status: KnowledgeStatusSchema,
  feature: KnowledgeIdSchema
});

export const FeatureMapTransitionEntrySchema = z.strictObject({
  id: KnowledgeIdSchema,
  status: KnowledgeStatusSchema,
  fromScreen: KnowledgeIdSchema,
  toScreen: KnowledgeIdSchema,
  action: z.string().trim().min(1),
  observations: z.strictObject({
    attempts: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    recoveryCost: z.number().nonnegative()
  }).superRefine((observations, context) => {
    if (observations.successes > observations.attempts) {
      context.addIssue({
        code: "custom",
        path: ["successes"],
        message: "Transition successes cannot exceed attempts"
      });
    }
  })
});

export const FeatureMapAnchorEntrySchema = z.strictObject({
  id: KnowledgeIdSchema,
  status: KnowledgeStatusSchema,
  roles: z.array(AnchorRoleSchema).min(1)
});

/**
 * Feature Map Projection: a read-only, deterministic, agent-friendly view of
 * the committed Knowledge Registry. It is never a second Source of Truth:
 * every field is derived from the bundle, and the bundle hash is carried so
 * consumers can detect drift. Natural-language narration is produced by an
 * external Agent Skill, not by Core.
 */
export const FeatureMapProjectionSchema = z.strictObject({
  version: z.literal(1),
  packageName: QualifiedNameSchema,
  knowledgeHash: KnowledgeSha256Schema,
  revision: z.number().int().nonnegative(),
  entryScreens: z.array(FeatureMapScreenEntrySchema).min(1),
  features: z.array(FeatureMapFeatureSchema).min(1),
  transitions: z.array(FeatureMapTransitionEntrySchema),
  anchors: z.array(FeatureMapAnchorEntrySchema)
});

export type FeatureMapFeature = z.infer<typeof FeatureMapFeatureSchema>;
export type FeatureMapScreenEntry = z.infer<
  typeof FeatureMapScreenEntrySchema
>;
export type FeatureMapTransitionEntry = z.infer<
  typeof FeatureMapTransitionEntrySchema
>;
export type FeatureMapAnchorEntry = z.infer<
  typeof FeatureMapAnchorEntrySchema
>;
export type FeatureMapProjection = z.infer<
  typeof FeatureMapProjectionSchema
>;