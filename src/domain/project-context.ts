import { z } from "zod";

const QualifiedNameSchema = z.string().regex(
  /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/,
  "Value must be fully qualified"
);

const GenerationActionSchema = z.enum([
  "click",
  "longClick",
  "inputText",
  "swipe",
  "scrollTo",
  "back",
  "wait"
]);

export const ContextEvidenceConfidenceSchema = z.enum([
  "sourceConfirmed",
  "runtimeConfirmed",
  "inferred",
  "unknown"
]);
export type ContextEvidenceConfidence = z.infer<
  typeof ContextEvidenceConfidenceSchema
>;

export const ProjectRelativePathSchema = z.string()
  .trim()
  .min(1)
  .transform((path) => path.replaceAll("\\", "/"))
  .refine(
    (path) => (
      !path.startsWith("/")
      && !/^[A-Za-z]:/.test(path)
      && !path.split("/").includes("..")
    ),
    "Path must stay within the project"
  );

const ContextFileSchema = z.strictObject({
  path: ProjectRelativePathSchema,
  sha256: z.string().regex(/^[a-f\d]{64}$/),
  semanticSha256: z.string().regex(/^[a-f\d]{64}$/).optional(),
  confidence: ContextEvidenceConfidenceSchema
});

export const ContextManifestSchema = z.strictObject({
  version: z.literal(1),
  files: z.array(ContextFileSchema).min(1)
}).superRefine((manifest, context) => {
  const paths = new Set<string>();
  for (const [index, file] of manifest.files.entries()) {
    if (paths.has(file.path)) {
      context.addIssue({
        code: "custom",
        path: ["files", index, "path"],
        message: "Context evidence paths must be unique"
      });
    }
    paths.add(file.path);
  }
});

export const InteractionPolicySchema = z.strictObject({
  allowedActions: z.array(GenerationActionSchema),
  confirmationRequiredActions: z.array(GenerationActionSchema),
  forbiddenActions: z.array(GenerationActionSchema)
}).superRefine((policy, context) => {
  const forbidden = new Set(policy.forbiddenActions);
  const overlap = policy.allowedActions.find((action) => forbidden.has(action));
  if (overlap !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["forbiddenActions"],
      message: `${overlap} cannot be both allowed and forbidden`
    });
  }

  const allowed = new Set(policy.allowedActions);
  const invalidConfirmation = policy.confirmationRequiredActions.find(
    (action) => !allowed.has(action)
  );
  if (invalidConfirmation !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["confirmationRequiredActions"],
      message: `${invalidConfirmation} must be allowed before requiring confirmation`
    });
  }
});

const NonemptyUniqueStringsSchema = z.array(z.string().trim().min(1))
  .superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Values must be unique"
        });
      }
      seen.add(value);
    }
  });

export const ContextShardStatusSchema = z.enum([
  "complete",
  "partial",
  "unsupported",
  "notAnalyzed"
]);

export const ContextModuleReferenceSchema = z.strictObject({
  id: z.string().trim().min(1),
  projectDir: ProjectRelativePathSchema,
  kind: z.enum(["application", "feature", "library"]),
  contextPath: ProjectRelativePathSchema,
  sha256: z.string().regex(/^[a-f\d]{64}$/),
  features: NonemptyUniqueStringsSchema,
  activities: z.array(QualifiedNameSchema).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        message: "Module Activity names must be unique"
      });
    }
  }),
  dependsOn: NonemptyUniqueStringsSchema,
  status: ContextShardStatusSchema
});

export const ProjectContextSchema = z.strictObject({
  version: z.literal(2),
  packageName: QualifiedNameSchema,
  launchActivity: QualifiedNameSchema,
  manifest: ContextManifestSchema,
  interactionPolicy: InteractionPolicySchema,
  modules: z.array(ContextModuleReferenceSchema).min(1)
}).superRefine((bundle, context) => {
  const ids = new Set<string>();
  const paths = new Set<string>();
  if (!bundle.modules.some((module) => module.kind === "application")) {
    context.addIssue({
      code: "custom",
      path: ["modules"],
      message: "Project Context needs at least one application module"
    });
  }
  for (const [index, module] of bundle.modules.entries()) {
    if (ids.has(module.id)) {
      context.addIssue({
        code: "custom",
        path: ["modules", index, "id"],
        message: "Context module ids must be unique"
      });
    }
    if (paths.has(module.contextPath)) {
      context.addIssue({
        code: "custom",
        path: ["modules", index, "contextPath"],
        message: "Context module paths must be unique"
      });
    }
    ids.add(module.id);
    paths.add(module.contextPath);
  }
  for (const [index, module] of bundle.modules.entries()) {
    for (const dependency of module.dependsOn) {
      if (!ids.has(dependency)) {
        context.addIssue({
          code: "custom",
          path: ["modules", index, "dependsOn"],
          message: `Unknown module dependency: ${dependency}`
        });
      }
      if (dependency === module.id) {
        context.addIssue({
          code: "custom",
          path: ["modules", index, "dependsOn"],
          message: "A Context module cannot depend on itself"
        });
      }
    }
  }
});

const ContextElementSchema = z.strictObject({
  screen: z.string().trim().min(1),
  resourceId: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1).optional(),
  contentDescription: z.string().trim().min(1).optional(),
  actions: z.array(GenerationActionSchema).min(1)
}).refine(
  (element) => (
    element.resourceId !== undefined
    || element.text !== undefined
    || element.contentDescription !== undefined
  ),
  "A Context element needs at least one locator identity"
);

const ContextActivitySummarySchema = z.strictObject({
  name: QualifiedNameSchema,
  entryPoints: z.array(QualifiedNameSchema),
  screens: NonemptyUniqueStringsSchema
});

const ContextTransitionSchema = z.strictObject({
  fromActivity: QualifiedNameSchema,
  actionResourceId: z.string().trim().min(1).optional(),
  actionText: z.string().trim().min(1).optional(),
  toActivity: QualifiedNameSchema
}).refine(
  (transition) => (
    transition.actionResourceId !== undefined
    || transition.actionText !== undefined
  ),
  "A Context transition needs an action identity"
);

const ContextLogcatCandidateSchema = z.strictObject({
  tag: z.string().trim().min(1),
  pattern: z.string().trim().min(1),
  match: z.enum(["literal", "regex"])
});

export const ProjectContextModuleSchema = z.strictObject({
  version: z.literal(2),
  moduleId: z.string().trim().min(1),
  projectDir: ProjectRelativePathSchema,
  status: ContextShardStatusSchema,
  inventory: z.strictObject({
    version: z.literal(2),
    pathSetSha256: z.string().regex(/^[a-f\d]{64}$/),
    categories: z.array(z.enum([
      "manifests",
      "sources",
      "layouts",
      "navigation"
    ])).min(1).superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: "Inventory categories must be unique"
        });
      }
    })
  }),
  manifest: ContextManifestSchema,
  summary: z.strictObject({
    features: NonemptyUniqueStringsSchema,
    activities: z.array(ContextActivitySummarySchema),
    elements: z.array(ContextElementSchema),
    transitions: z.array(ContextTransitionSchema),
    logcat: z.array(ContextLogcatCandidateSchema)
  })
});

export const ContextSelectionSchema = z.strictObject({
  bundleVersion: z.literal(2),
  indexHash: z.string().regex(/^[a-f\d]{64}$/),
  modules: z.array(z.strictObject({
    id: z.string().trim().min(1),
    sha256: z.string().regex(/^[a-f\d]{64}$/),
    projectDir: ProjectRelativePathSchema,
    inventory: z.strictObject({
      pathSetSha256: z.string().regex(/^[a-f\d]{64}$/),
      categories: z.array(z.enum([
        "manifests",
        "sources",
        "layouts",
        "navigation"
      ])).min(1).superRefine((values, context) => {
        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: "custom",
            message: "Bound inventory categories must be unique"
          });
        }
      })
    })
  })).min(1).superRefine((modules, context) => {
    const ids = new Set<string>();
    for (const [index, module] of modules.entries()) {
      if (ids.has(module.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "Selected Context module ids must be unique"
        });
      }
      ids.add(module.id);
    }
  })
});

export const ResolvedProjectContextSchema = z.strictObject({
  version: z.literal(2),
  packageName: QualifiedNameSchema,
  launchActivity: QualifiedNameSchema,
  manifest: ContextManifestSchema,
  interactionPolicy: InteractionPolicySchema,
  selection: ContextSelectionSchema
});

export type ContextManifest = z.infer<typeof ContextManifestSchema>;
export type InteractionPolicy = z.infer<typeof InteractionPolicySchema>;
export type ProjectContext = z.infer<typeof ProjectContextSchema>;
export type ContextModuleReference = z.infer<
  typeof ContextModuleReferenceSchema
>;
export type ProjectContextModule = z.infer<
  typeof ProjectContextModuleSchema
>;
export type ContextSelection = z.infer<
  typeof ContextSelectionSchema
>;
export type ResolvedProjectContext = z.infer<
  typeof ResolvedProjectContextSchema
>;
