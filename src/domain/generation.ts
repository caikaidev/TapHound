import { z } from "zod";

import {
  ProposedStepSchema,
  type ProposedStep
} from "./proposed-step.js";

export const GENERATION_ERROR_CODES = [
  "CONTEXT_INVALID",
  "CONTEXT_STALE",
  "SNAPSHOT_STALE",
  "PACKAGE_ESCAPE",
  "ACTION_UNSUPPORTED",
  "RISK_CONFIRMATION_REQUIRED",
  "ACTION_FORBIDDEN",
  "EXPECT_UNSUPPORTED",
  "RECOVERY_REQUIRED"
] as const;

export const GenerationErrorCodeSchema = z.enum(GENERATION_ERROR_CODES);
export type GenerationErrorCode = z.infer<typeof GenerationErrorCodeSchema>;

const Sha256Schema = z.string().regex(/^[a-f\d]{64}$/);

const LiteralSchema = z.string().refine(
  (value) => !value.includes("${") && !value.includes("}"),
  "Generation variable bindings must be literal"
);

export const GenerationVariablesSchema = z.strictObject({
  runId: LiteralSchema.regex(/^[A-Za-z\d](?:[A-Za-z\d._-]*[A-Za-z\d])?$/),
  timestamp: LiteralSchema.pipe(z.iso.datetime()),
  randomHex: LiteralSchema.regex(/^[a-f\d]+$/)
});

const InFlightSchema = z.strictObject({
  stepIndex: z.number().int().nonnegative(),
  snapshotHash: Sha256Schema
});

const PendingConfirmationSchema = z.strictObject({
  stepIndex: z.number().int().nonnegative(),
  reason: z.string().trim().min(1)
});

const GenerationFailureSchema = z.strictObject({
  code: GenerationErrorCodeSchema,
  message: z.string().trim().min(1)
});

const VerificationSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("notRun") }),
  z.strictObject({ status: z.literal("running") }),
  z.strictObject({ status: z.literal("passed") }),
  z.strictObject({
    status: z.literal("failed"),
    failure: GenerationFailureSchema
  })
]);

const PublicationSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("notRun") }),
  z.strictObject({
    status: z.literal("published"),
    journeyPath: z.string().trim().min(1)
  }),
  z.strictObject({
    status: z.literal("failed"),
    failure: GenerationFailureSchema
  })
]);

export const GenerationSessionSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  bindings: z.strictObject({
    contextHash: Sha256Schema,
    snapshotHash: Sha256Schema
  }),
  variables: GenerationVariablesSchema,
  candidateSteps: z.array(ProposedStepSchema),
  inFlight: InFlightSchema.nullable(),
  pendingConfirmation: PendingConfirmationSchema.nullable(),
  verification: VerificationSchema,
  publication: PublicationSchema
}).superRefine((session, context) => {
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
    if (state !== null && state.stepIndex >= session.candidateSteps.length) {
      context.addIssue({
        code: "custom",
        path: [field, "stepIndex"],
        message: "State stepIndex must reference a candidate step"
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
export type GenerationSession = z.infer<typeof GenerationSessionSchema>;

export function bindGenerationVariables(input: unknown): GenerationVariables {
  return GenerationVariablesSchema.parse(input);
}

function expandValue(
  value: unknown,
  variables: GenerationVariables
): unknown {
  if (typeof value === "string") {
    const expanded = value.replace(
      /\$\{([^{}]+)\}/g,
      (_match, name: string) => {
        if (name === "runId" || name === "timestamp" || name === "randomHex") {
          return variables[name];
        }
        throw new Error(`Unsupported generation variable: ${name}`);
      }
    );
    if (expanded.includes("${") || expanded.includes("}")) {
      throw new Error("Expanded value contains a malformed template marker");
    }
    return expanded;
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
