import { createHash } from "node:crypto";

import { z } from "zod";

import { FAILURE_CODES } from "./failure.js";

const ResultStatusSchema = z.enum(["passed", "failed", "notRun"]);
const RunStatusSchema = z.enum(["passed", "failed", "error"]);

export const ReportFailureSchema = z.strictObject({
  code: z.enum(FAILURE_CODES),
  message: z.string().min(1),
  phase: z.string().min(1),
  stepIndex: z.number().int().nonnegative().optional()
});

const LocatorReportSchema = z.strictObject({
  status: z.enum(["found", "failed", "notRun"]),
  matchedBy: z.enum([
    "resourceId",
    "text",
    "contentDescription"
  ]).optional(),
  fallbackUsed: z.boolean(),
  fallbackLabel: z.string().regex(/^#\d+$/).optional(),
  annotatedScreenshotPath: z.string().min(1).optional(),
  message: z.string().min(1).optional()
}).superRefine((locator, context) => {
  if (
    locator.fallbackUsed
    && (
      locator.fallbackLabel === undefined
      || locator.annotatedScreenshotPath === undefined
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Fallback evidence requires label and annotated screenshot"
    });
  }
});

const IdleReportSchema = z.strictObject({
  status: z.enum(["stable", "timeout", "cancelled", "notRun"]),
  polls: z.number().int().nonnegative(),
  lastDiff: z.array(z.unknown()).optional()
});

const ActivityCheckSchema = z.strictObject({
  status: ResultStatusSchema,
  expected: z.string().min(1),
  actual: z.string().min(1).optional()
});

const StepExpectationSchema = z.strictObject({
  type: z.enum(["activity", "element", "logcat"]),
  status: ResultStatusSchema,
  code: z.enum(FAILURE_CODES).optional(),
  message: z.string().min(1).optional()
});

export const StepReportSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  action: z.enum([
    "click",
    "longClick",
    "inputText",
    "swipe",
    "back",
    "wait"
  ]),
  status: ResultStatusSchema,
  startedAtMs: z.number().nonnegative(),
  finishedAtMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  locator: LocatorReportSchema.optional(),
  idle: IdleReportSchema.optional(),
  activity: z.strictObject({
    before: ActivityCheckSchema,
    after: ActivityCheckSchema
  }).optional(),
  expectation: StepExpectationSchema.optional(),
  logcatPath: z.string().min(1).optional()
});

const LayersSchema = z.strictObject({
  build: ResultStatusSchema,
  run: ResultStatusSchema,
  structural: ResultStatusSchema,
  activityCheckpoint: ResultStatusSchema,
  explicitExpect: ResultStatusSchema,
  collection: ResultStatusSchema
});

const ArtifactsSchema = z.strictObject({
  directory: z.string().min(1),
  report: z.string().min(1),
  summary: z.string().min(1),
  screenshot: z.string().min(1).optional(),
  logcat: z.string().min(1).optional(),
  stepLogs: z.array(z.string().min(1))
});

export const AprReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  status: RunStatusSchema,
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().nonnegative(),
  project: z.strictObject({
    root: z.string().min(1),
    packageName: z.string().min(1),
    launchActivity: z.string().min(1)
  }),
  journey: z.strictObject({
    name: z.string().min(1),
    sha256: z.string().regex(/^[a-f\d]{64}$/)
  }),
  environment: z.strictObject({
    deviceSerial: z.string().min(1),
    tools: z.record(z.string(), z.string())
  }),
  layers: LayersSchema,
  steps: z.array(StepReportSchema),
  artifacts: ArtifactsSchema,
  primaryFailure: ReportFailureSchema.optional(),
  secondaryErrors: z.array(ReportFailureSchema),
  fallbackUsed: z.boolean()
});

export type ReportFailure = z.infer<typeof ReportFailureSchema>;
export type StepReport = z.infer<typeof StepReportSchema>;
export type AprReport = z.infer<typeof AprReportSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
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

export function hashJourney(journey: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(journey)))
    .digest("hex");
}
