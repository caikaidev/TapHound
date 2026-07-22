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
  sha256: z.string().regex(/^[a-f\d]{64}$/)
});

export const ContextManifestSchema = z.strictObject({
  version: z.literal(1),
  files: z.array(ContextFileSchema).min(1)
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

export const ProjectContextSchema = z.strictObject({
  version: z.literal(1),
  packageName: QualifiedNameSchema,
  launchActivity: QualifiedNameSchema,
  manifest: ContextManifestSchema,
  interactionPolicy: InteractionPolicySchema
});

export type ContextManifest = z.infer<typeof ContextManifestSchema>;
export type InteractionPolicy = z.infer<typeof InteractionPolicySchema>;
export type ProjectContext = z.infer<typeof ProjectContextSchema>;
