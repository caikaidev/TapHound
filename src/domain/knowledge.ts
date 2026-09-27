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

export const QualifiedNameSchema = z.string().regex(
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

export const AnchorCandidateKindSchema = z.enum([
  "composeSemantics",
  "resourceId",
  "contentDescription",
  "visibleText",
  "visualMatch"
]);

export const AnchorCandidateSchema = z.strictObject({
  kind: AnchorCandidateKindSchema,
  locator: LocatorSchema
}).superRefine((candidate, context) => {
  if (candidate.kind === "visualMatch") {
    context.addIssue({
      code: "custom",
      path: ["locator"],
      message: "visualMatch candidates are resolved by an external multimodal layer, never by Core"
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
  candidates: z.array(AnchorCandidateSchema).optional().superRefine((candidates, context) => {
    if (candidates === undefined) {
      return;
    }
    const kinds = candidates.map((candidate) => candidate.kind);
    if (new Set(kinds).size !== kinds.length) {
      context.addIssue({
        code: "custom",
        message: "Anchor candidate kinds must be unique"
      });
    }
  }),
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
  screens: z.array(KnowledgeReferenceSchema).min(1)
}).superRefine((bundle, context) => {
  for (const [field, references] of [
    ["anchors", bundle.anchors],
    ["screens", bundle.screens]
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
export type AnchorCandidateKind = z.infer<typeof AnchorCandidateKindSchema>;
export type AnchorCandidate = z.infer<typeof AnchorCandidateSchema>;
export type AnchorDefinition = z.infer<typeof AnchorDefinitionSchema>;
export type StatePredicate = z.infer<typeof StatePredicateSchema>;
export type ScreenDefinition = z.infer<typeof ScreenDefinitionSchema>;
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
