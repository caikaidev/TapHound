import { createHash } from "node:crypto";

import { z } from "zod";

import { JourneyStepSchema } from "./journey.js";
import { FlowNameSchema } from "./journey-composition.js";
import { ProjectRelativePathSchema } from "./project-context.js";
import { InteractionPolicySchema } from "./project-context.js";
import { ContextSelectionSchema } from "./project-context.js";
import {
  ProposedStepSchema,
  type ProposedStep
} from "./proposed-step.js";
import { RuntimeSnapshotSchema } from "./runtime-snapshot.js";

export const GENERATION_ERROR_CODES = [
  "CONFIG_INVALID",
  "CONTEXT_INVALID",
  "CONTEXT_STALE",
  "FLOW_INVALID",
  "FLOW_REPLAY_FAILED",
  "APP_LAUNCH_FAILED",
  "SNAPSHOT_STALE",
  "PACKAGE_ESCAPE",
  "BRIDGE_NO_ESCAPE",
  "SCENARIO_PACKAGE_MISMATCH",
  "BRIDGE_NOT_RETURNED",
  "APP_CRASHED",
  "IDLE_TIMEOUT",
  "WINDOW_HIERARCHY_INCOMPLETE",
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

export const GenerationStepSourceSchema = z.enum([
  "flow",
  "planner",
  "manualOverride"
]);

export const GenerationBaseFlowSchema = z.strictObject({
  name: FlowNameSchema,
  resolutionSha256: Sha256Schema,
  journeySha256: Sha256Schema,
  verificationReportSha256: Sha256Schema,
  verificationRunId: z.string().min(1),
  stepCount: z.number().int().positive()
});

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
  attemptId: GenerationSessionIdSchema,
  confirmation: z.strictObject({
    challengeId: GenerationSessionIdSchema,
    approvalMode: z.enum(["localTty", "delegated"])
  }).optional()
});

export const PendingConfirmationSchema = z.strictObject({
  challengeId: GenerationSessionIdSchema,
  stepIndex: z.number().int().nonnegative(),
  proposalHash: Sha256Schema,
  snapshotHash: Sha256Schema,
  evidenceHash: Sha256Schema,
  actionSummary: z.string().trim().min(1),
  expiresAt: z.iso.datetime(),
  status: z.enum(["pending", "approved"]),
  approvalMode: z.enum(["localTty", "delegated"]).optional()
});

const GenerationFailureSchema = z.strictObject({
  code: GenerationErrorCodeSchema,
  message: z.string().trim().min(1)
});

const VerificationSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("notRun") }),
  z.strictObject({
    status: z.literal("running"),
    attemptId: GenerationSessionIdSchema,
    ownerPid: z.number().int().positive().optional(),
    startedAt: z.iso.datetime().optional()
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
  state: z.enum(["active", "recoveryRequired", "archived"]),
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
  contextSelection: ContextSelectionSchema,
  variables: GenerationVariablesSchema,
  baseFlow: GenerationBaseFlowSchema.optional(),
  candidateSteps: z.array(JourneyStepSchema),
  candidateSources: z.array(GenerationStepSourceSchema),
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
  const flowStepCount = session.candidateSources.filter(
    (source) => source === "flow"
  ).length;
  if (
    (session.baseFlow === undefined && flowStepCount !== 0)
    || (
      session.baseFlow !== undefined
      && (
        flowStepCount !== session.baseFlow.stepCount
        || session.candidateSources.slice(0, flowStepCount).some(
          (source) => source !== "flow"
        )
      )
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["baseFlow"],
      message: "Base Flow provenance must be a contiguous candidate prefix"
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

  if (
    session.state === "archived"
    && (session.inFlight !== null || session.pendingConfirmation !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["state"],
      message: "Archived sessions must not carry in-flight work or pending confirmation"
    });
  }
});

export type GenerationVariables = z.infer<typeof GenerationVariablesSchema>;
export type GenerationInFlight = z.infer<typeof GenerationInFlightSchema>;
export type PendingConfirmation = z.infer<typeof PendingConfirmationSchema>;
export type GenerationSession = z.infer<typeof GenerationSessionSchema>;

export function isGenerationConfirmationExpired(
  challenge: PendingConfirmation,
  now: Date
): boolean {
  return now.getTime() >= new Date(challenge.expiresAt).getTime();
}

export const GenerationConfirmationEvidenceSchema = z.strictObject({
  version: z.literal(1),
  proposal: ProposedStepSchema,
  snapshot: RuntimeSnapshotSchema,
  source: z.enum(["planner", "manualOverride"])
});

export type GenerationConfirmationEvidence = z.infer<
  typeof GenerationConfirmationEvidenceSchema
>;

function canonicalizeConfirmationEvidence(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeConfirmationEvidence);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (
          left < right ? -1 : left > right ? 1 : 0
        ))
        .map(([key, item]) => [
          key,
          canonicalizeConfirmationEvidence(item)
        ])
    );
  }
  return value;
}

export function hashGenerationConfirmationEvidence(value: unknown): string {
  const evidence = GenerationConfirmationEvidenceSchema.parse(value);
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeConfirmationEvidence(evidence)))
    .digest("hex");
}

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
  baseFlow: GenerationBaseFlowSchema.optional(),
  manualOverrideStepIndexes: z.array(z.number().int().nonnegative())
});

export const GenerationReportSchema = z.strictObject({
  version: z.literal(1),
  generationId: GenerationSessionIdSchema,
  status: z.literal("verified"),
  steps: z.array(z.strictObject({
    index: z.number().int().nonnegative(),
    source: GenerationStepSourceSchema
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
  contextSelection: GenerationSession["contextSelection"];
  variables: GenerationSession["variables"];
  baseFlow?: NonNullable<GenerationSession["baseFlow"]> | undefined;
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
    contextSelection: session.contextSelection,
    variables: session.variables,
    ...(session.baseFlow === undefined ? {} : { baseFlow: session.baseFlow })
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
