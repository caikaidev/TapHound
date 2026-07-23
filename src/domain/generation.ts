import { z } from "zod";

import { JourneyStepSchema } from "./journey.js";
import { ProjectRelativePathSchema } from "./project-context.js";
import { InteractionPolicySchema } from "./project-context.js";
import {
  ProposedStepSchema,
  type ProposedStep
} from "./proposed-step.js";

export const GENERATION_ERROR_CODES = [
  "CONFIG_INVALID",
  "CONTEXT_INVALID",
  "CONTEXT_STALE",
  "SNAPSHOT_STALE",
  "PACKAGE_ESCAPE",
  "APP_CRASHED",
  "ACTION_UNSUPPORTED",
  "RISK_CONFIRMATION_REQUIRED",
  "ACTION_FORBIDDEN",
  "EXPECT_UNSUPPORTED",
  "RECOVERY_REQUIRED",
  "VERIFICATION_FAILED",
  "PUBLICATION_FAILED",
  "EXPORT_FAILED",
  "FINALIZATION_IN_PROGRESS"
] as const;

export const GenerationErrorCodeSchema = z.enum(GENERATION_ERROR_CODES);
export type GenerationErrorCode = z.infer<typeof GenerationErrorCodeSchema>;

const Sha256Schema = z.string().regex(/^[a-f\d]{64}$/);

export const GenerationSessionIdSchema = z.string().regex(
  /^[A-Za-z\d](?:[A-Za-z\d._-]*[A-Za-z\d])?$/,
  "Generation session id must be a safe directory name"
);

const LiteralSchema = z.string().refine(
  (value) => !value.includes("${") && !value.includes("}"),
  "Generation variable bindings must be literal"
);

export const GenerationVariablesSchema = z.strictObject({
  runId: LiteralSchema.regex(/^[A-Za-z\d](?:[A-Za-z\d._-]*[A-Za-z\d])?$/),
  timestamp: LiteralSchema.pipe(z.iso.datetime()),
  randomHex: LiteralSchema.regex(/^[a-f\d]+$/)
});

const NonnegativeSafeIntegerSchema = z.number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const GenerationInFlightSchema = z.strictObject({
  stepIndex: z.number().int().nonnegative(),
  snapshotHash: Sha256Schema,
  proposalHash: Sha256Schema,
  attemptId: GenerationSessionIdSchema
});

export const PendingConfirmationSchema = z.strictObject({
  challengeId: GenerationSessionIdSchema,
  stepIndex: z.number().int().nonnegative(),
  proposalHash: Sha256Schema,
  snapshotHash: Sha256Schema,
  actionSummary: z.string().trim().min(1),
  expiresAt: z.iso.datetime(),
  status: z.enum(["pending", "approved"])
});

const GenerationFailureSchema = z.strictObject({
  code: GenerationErrorCodeSchema,
  message: z.string().trim().min(1)
});

const VerificationSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("notRun") }),
  z.strictObject({
    status: z.literal("running"),
    attemptId: GenerationSessionIdSchema
  }),
  z.strictObject({
    status: z.literal("passed"),
    attemptId: GenerationSessionIdSchema,
    reportPath: z.string().min(1),
    reportSha256: Sha256Schema,
    runId: z.string().min(1)
  }),
  z.strictObject({
    status: z.literal("failed"),
    failure: GenerationFailureSchema
  })
]);

const PublicationSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("notRun") }),
  z.strictObject({
    status: z.literal("published"),
    journeyPath: ProjectRelativePathSchema
  }),
  z.strictObject({
    status: z.literal("failed"),
    failure: GenerationFailureSchema
  })
]);

export const GenerationSessionSchema = z.strictObject({
  version: z.literal(1),
  id: GenerationSessionIdSchema,
  revision: NonnegativeSafeIntegerSchema,
  state: z.enum(["active", "recoveryRequired"]),
  bindings: z.strictObject({
    projectHash: Sha256Schema,
    configHash: Sha256Schema,
    contextHash: Sha256Schema,
    snapshotHash: Sha256Schema.nullable()
  }),
  target: z.strictObject({
    packageName: z.string().regex(
      /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/
    ),
    deviceSerial: z.string().trim().min(1),
    resetStrategy: z.literal("processOnly"),
    interactionPolicy: InteractionPolicySchema
  }),
  variables: GenerationVariablesSchema,
  candidateSteps: z.array(JourneyStepSchema),
  candidateSources: z.array(z.enum(["planner", "manualOverride"])),
  inFlight: GenerationInFlightSchema.nullable(),
  pendingConfirmation: PendingConfirmationSchema.nullable(),
  verification: VerificationSchema,
  publication: PublicationSchema
}).superRefine((session, context) => {
  if (session.candidateSources.length !== session.candidateSteps.length) {
    context.addIssue({
      code: "custom",
      path: ["candidateSources"],
      message: "Candidate provenance must align exactly with candidate steps"
    });
  }
  if (session.state === "recoveryRequired" && session.inFlight === null) {
    context.addIssue({
      code: "custom",
      path: ["state"],
      message: "recoveryRequired state must preserve inFlight evidence"
    });
  }

  if (session.inFlight !== null && session.pendingConfirmation !== null) {
    context.addIssue({
      code: "custom",
      message: "inFlight and pendingConfirmation cannot both be active"
    });
  }

  for (const [field, state] of [
    ["inFlight", session.inFlight],
    ["pendingConfirmation", session.pendingConfirmation]
  ] as const) {
    if (state !== null && state.stepIndex !== session.candidateSteps.length) {
      context.addIssue({
        code: "custom",
        path: [field, "stepIndex"],
        message: "State stepIndex must equal the next candidate index"
      });
    }
  }

  if (
    session.verification.status !== "notRun"
    && (session.inFlight !== null || session.pendingConfirmation !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["verification"],
      message: "Verification cannot run while candidate step state is active"
    });
  }

  if (
    session.publication.status === "published"
    && session.verification.status !== "passed"
  ) {
    context.addIssue({
      code: "custom",
      path: ["publication"],
      message: "Publication requires passed verification"
    });
  }

  if (
    session.publication.status === "failed"
    && session.verification.status !== "passed"
  ) {
    context.addIssue({
      code: "custom",
      path: ["publication"],
      message: "Publication can only start after passed verification"
    });
  }
});

export type GenerationVariables = z.infer<typeof GenerationVariablesSchema>;
export type GenerationInFlight = z.infer<typeof GenerationInFlightSchema>;
export type PendingConfirmation = z.infer<typeof PendingConfirmationSchema>;
export type GenerationSession = z.infer<typeof GenerationSessionSchema>;

const BundleRelativePathSchema = z.string().min(1).superRefine(
  (path, context) => {
    if (
      path.includes("\\")
      || path.includes("\0")
      || path.startsWith("/")
      || /^[A-Za-z]:/.test(path)
      || path.split("/").some(
        (segment) => segment.length === 0 || segment === "." || segment === ".."
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Path must be a safe bundle-relative path"
      });
    }
  }
);

export const GenerationMetaSchema = z.strictObject({
  version: z.literal(1),
  status: z.literal("verified"),
  generationId: GenerationSessionIdSchema,
  journeyPath: ProjectRelativePathSchema,
  bindings: z.strictObject({
    projectHash: Sha256Schema,
    configHash: Sha256Schema,
    contextHash: Sha256Schema
  }),
  verification: z.strictObject({
    reportPath: BundleRelativePathSchema,
    reportSha256: Sha256Schema,
    runId: z.string().min(1),
    runs: z.literal(1)
  }),
  manualOverrideStepIndexes: z.array(z.number().int().nonnegative())
});

export const GenerationReportSchema = z.strictObject({
  version: z.literal(1),
  generationId: GenerationSessionIdSchema,
  status: z.literal("verified"),
  steps: z.array(z.strictObject({
    index: z.number().int().nonnegative(),
    source: z.enum(["planner", "manualOverride"])
  })).min(1)
}).superRefine((report, context) => {
  for (const [index, step] of report.steps.entries()) {
    if (step.index !== index) {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "index"],
        message: "Generation report step indexes must be contiguous"
      });
    }
  }
});

export const GenerationBundleManifestEntrySchema = z.strictObject({
  path: BundleRelativePathSchema,
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: Sha256Schema
});

export const GenerationBundleManifestSchema = z.strictObject({
  version: z.literal(1),
  generationId: GenerationSessionIdSchema,
  files: z.array(GenerationBundleManifestEntrySchema).min(1)
}).superRefine((manifest, context) => {
  const paths = new Set<string>();
  for (const [index, file] of manifest.files.entries()) {
    if (file.path === "manifest.json") {
      context.addIssue({
        code: "custom",
        path: ["files", index, "path"],
        message: "Manifest cannot include itself"
      });
    }
    if (paths.has(file.path)) {
      context.addIssue({
        code: "custom",
        path: ["files", index, "path"],
        message: "Manifest file paths must be unique"
      });
    }
    paths.add(file.path);
  }
});

export type GenerationMeta = z.infer<typeof GenerationMetaSchema>;
export type GenerationReport = z.infer<typeof GenerationReportSchema>;
export type GenerationBundleManifest = z.infer<
  typeof GenerationBundleManifestSchema
>;
export interface GenerationCoreIdentity {
  id: GenerationSession["id"];
  bindings: Pick<
    GenerationSession["bindings"],
    "projectHash" | "configHash" | "contextHash"
  >;
  target: GenerationSession["target"];
  variables: GenerationSession["variables"];
}

export function generationCoreIdentity(
  session: GenerationSession
): GenerationCoreIdentity {
  return {
    id: session.id,
    bindings: {
      projectHash: session.bindings.projectHash,
      configHash: session.bindings.configHash,
      contextHash: session.bindings.contextHash
    },
    target: session.target,
    variables: session.variables
  };
}

export function bindGenerationVariables(input: unknown): GenerationVariables {
  return GenerationVariablesSchema.parse(input);
}

function expandString(
  value: string,
  variables: GenerationVariables
): string {
  let expanded = "";
  let index = 0;
  let literalBraceDepth = 0;

  while (index < value.length) {
    if (value.startsWith("${", index)) {
      const closingIndex = value.indexOf("}", index + 2);
      if (closingIndex === -1) {
        throw new Error("Incomplete generation template marker");
      }

      const name = value.slice(index + 2, closingIndex);
      if (name.length === 0 || name.includes("{") || name.includes("${")) {
        throw new Error("Malformed or nested generation template marker");
      }
      if (name !== "runId" && name !== "timestamp" && name !== "randomHex") {
        throw new Error(`Unsupported generation variable: ${name}`);
      }

      expanded += variables[name];
      index = closingIndex + 1;
      if (value.charAt(index) === "}" && literalBraceDepth === 0) {
        throw new Error("Duplicated generation template marker closing");
      }
      continue;
    }

    const character = value.charAt(index);
    if (character === "{") {
      literalBraceDepth += 1;
    } else if (character === "}" && literalBraceDepth > 0) {
      literalBraceDepth -= 1;
    }
    expanded += character;
    index += 1;
  }

  return expanded;
}

function expandValue(
  value: unknown,
  variables: GenerationVariables
): unknown {
  if (typeof value === "string") {
    return expandString(value, variables);
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandValue(item, variables));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([key, item]) => [key, expandValue(item, variables)]
      )
    );
  }
  return value;
}

export function expandGenerationVariables(
  value: unknown,
  variables: unknown
): unknown {
  return expandValue(value, bindGenerationVariables(variables));
}

export function expandProposedStepVariables(
  step: unknown,
  variables: unknown
): ProposedStep {
  return ProposedStepSchema.parse(expandGenerationVariables(step, variables));
}
