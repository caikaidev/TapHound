import { createHash } from "node:crypto";

import { z } from "zod";

import { LocatorSchema } from "./layout.js";
import { ProjectRelativePathSchema } from "./project-context.js";

export const KnowledgeIdSchema = z.string().regex(
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/,
  "Knowledge identifiers must be stable file-safe names"
);
export const KnowledgeStatusSchema = z.enum([
  "inferred",
  "observed",
  "verified"
]);
export const KnowledgeSha256Schema = z.string().regex(/^[a-f\d]{64}$/);

const QualifiedNameSchema = z.string().regex(
  /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/,
  "Value must be fully qualified"
);

export const AnchorRoleSchema = z.enum([
  "screenIdentity",
  "actionable",
  "transitionVerification"
]);

const WindowIdentitySchema = z.strictObject({
  kind: z.literal("window"),
  title: z.string().trim().min(1).optional(),
  packageName: QualifiedNameSchema.optional(),
  type: z.string().trim().min(1).optional()
}).refine(
  (identity) => (
    identity.title !== undefined
    || identity.packageName !== undefined
    || identity.type !== undefined
  ),
  "A window Anchor needs at least one stable identity field"
);

export const AnchorIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("activity"),
    activity: QualifiedNameSchema
  }),
  WindowIdentitySchema,
  z.strictObject({
    kind: z.literal("element"),
    locator: LocatorSchema
  })
]);

export const KnowledgeSourceFilesSchema = z.array(
  ProjectRelativePathSchema
).superRefine((paths, context) => {
  if (new Set(paths).size !== paths.length) {
    context.addIssue({
      code: "custom",
      message: "Knowledge source files must be unique"
    });
  }
});

export const AnchorDefinitionSchema = z.strictObject({
  version: z.literal(1),
  id: KnowledgeIdSchema,
  status: KnowledgeStatusSchema,
  roles: z.array(AnchorRoleSchema).min(1).superRefine((roles, context) => {
    if (new Set(roles).size !== roles.length) {
      context.addIssue({
        code: "custom",
        message: "Anchor roles must be unique"
      });
    }
  }),
  identity: AnchorIdentitySchema,
  description: z.string().trim().min(1).optional(),
  sourceFiles: KnowledgeSourceFilesSchema.optional()
});

export const StatePredicateSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("activityIs"),
    activity: QualifiedNameSchema
  }),
  z.strictObject({
    kind: z.literal("anchorPresent"),
    anchorId: KnowledgeIdSchema
  }),
  z.strictObject({
    kind: z.literal("anchorAbsent"),
    anchorId: KnowledgeIdSchema
  }),
  z.strictObject({
    kind: z.literal("windowPresent"),
    anchorId: KnowledgeIdSchema
  })
]);

export const ScreenDefinitionSchema = z.strictObject({
  version: z.literal(1),
  id: KnowledgeIdSchema,
  status: KnowledgeStatusSchema,
  requiredAnchors: z.array(KnowledgeIdSchema).min(1),
  optionalAnchors: z.array(KnowledgeIdSchema).default([]),
  forbiddenAnchors: z.array(KnowledgeIdSchema).default([]),
  predicates: z.array(StatePredicateSchema).default([]),
  description: z.string().trim().min(1).optional(),
  sourceFiles: KnowledgeSourceFilesSchema.optional()
}).superRefine((screen, context) => {
  const groups = [
    screen.requiredAnchors,
    screen.optionalAnchors,
    screen.forbiddenAnchors
  ];
  const all = groups.flat();
  if (new Set(all).size !== all.length) {
    context.addIssue({
      code: "custom",
      message: "Screen Anchor sets must be unique and disjoint"
    });
  }
});

const TransitionActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("click"),
    anchorId: KnowledgeIdSchema
  }),
  z.strictObject({
    action: z.literal("longClick"),
    anchorId: KnowledgeIdSchema,
    durationMs: z.number().int().positive().default(800)
  }),
  z.strictObject({
    action: z.literal("inputText"),
    parameter: KnowledgeIdSchema
  }),
  z.strictObject({
    action: z.literal("swipe"),
    anchorId: KnowledgeIdSchema,
    direction: z.enum(["up", "down", "left", "right"]),
    distancePercent: z.number().positive().max(1).default(0.6),
    durationMs: z.number().int().positive().default(300)
  }),
  z.strictObject({
    action: z.literal("scrollTo"),
    anchorId: KnowledgeIdSchema,
    containerAnchorId: KnowledgeIdSchema,
    direction: z.enum(["up", "down", "left", "right"]),
    maxSwipes: z.number().int().positive().max(30).default(20),
    distancePercent: z.number().positive().max(1).default(0.6),
    durationMs: z.number().int().positive().default(300)
  }),
  z.strictObject({ action: z.literal("back") }),
  z.strictObject({ action: z.literal("wait") })
]);

export const TransitionDefinitionSchema = z.strictObject({
  version: z.literal(1),
  id: KnowledgeIdSchema,
  status: KnowledgeStatusSchema,
  fromScreen: KnowledgeIdSchema,
  toScreen: KnowledgeIdSchema,
  semantic: KnowledgeIdSchema,
  action: TransitionActionSchema,
  verification: z.strictObject({
    targetScreen: KnowledgeIdSchema,
    timeoutMs: z.number().int().positive()
  }),
  sourceFiles: KnowledgeSourceFilesSchema.optional(),
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
  }).default({ attempts: 0, successes: 0, recoveryCost: 0 })
}).superRefine((transition, context) => {
  if (transition.verification.targetScreen !== transition.toScreen) {
    context.addIssue({
      code: "custom",
      path: ["verification", "targetScreen"],
      message: "Transition verification must target toScreen"
    });
  }
});

export const KnowledgeReferenceSchema = z.strictObject({
  id: KnowledgeIdSchema,
  path: ProjectRelativePathSchema,
  sha256: KnowledgeSha256Schema,
  status: KnowledgeStatusSchema
});

export const KnowledgeBundleIndexSchema = z.strictObject({
  version: z.literal(1),
  packageName: QualifiedNameSchema,
  revision: z.number().int().nonnegative(),
  anchors: z.array(KnowledgeReferenceSchema),
  screens: z.array(KnowledgeReferenceSchema).min(1),
  transitions: z.array(KnowledgeReferenceSchema)
}).superRefine((bundle, context) => {
  for (const [field, references] of [
    ["anchors", bundle.anchors],
    ["screens", bundle.screens],
    ["transitions", bundle.transitions]
  ] as const) {
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const [index, reference] of references.entries()) {
      if (ids.has(reference.id)) {
        context.addIssue({
          code: "custom",
          path: [field, index, "id"],
          message: "Knowledge reference ids must be unique"
        });
      }
      if (paths.has(reference.path)) {
        context.addIssue({
          code: "custom",
          path: [field, index, "path"],
          message: "Knowledge reference paths must be unique"
        });
      }
      ids.add(reference.id);
      paths.add(reference.path);
    }
  }
});

export type KnowledgeStatus = z.infer<typeof KnowledgeStatusSchema>;
export type AnchorDefinition = z.infer<typeof AnchorDefinitionSchema>;
export type StatePredicate = z.infer<typeof StatePredicateSchema>;
export type ScreenDefinition = z.infer<typeof ScreenDefinitionSchema>;
export type TransitionDefinition = z.infer<typeof TransitionDefinitionSchema>;
export type KnowledgeBundleIndex = z.infer<typeof KnowledgeBundleIndexSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function hashKnowledge(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}
