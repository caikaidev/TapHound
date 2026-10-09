import { z } from "zod";

import { FAILURE_CODES } from "./failure.js";
import { GENERATION_ERROR_CODES } from "./generation.js";
import { RuntimeBackendChoiceSchema } from "./runtime.js";
import { UiBackendIdSchema, UiBackendSelectionSchema } from "./ui-backend.js";
import { UiCacheTelemetrySchema } from "./ui-cache.js";

/**
 * Diagnostics exist so a user can attach evidence to TapHound feedback
 * without leaking their project. Every schema here is an allowlist: a field
 * that is not declared cannot reach the journal or an exported bundle, and
 * no field carries a path, package, Activity, Journey name, locator value,
 * device serial, or free-text message.
 */

export const DIAGNOSTICS_EVENTS_FILE = "events.jsonl";
export const DIAGNOSTICS_EVENTS_ROTATED_FILE = "events.1.jsonl";
export const DIAGNOSTICS_SALT_FILE = "salt";
export const DIAGNOSTICS_DISABLE_ENV_VAR = "TAPHOUND_DIAGNOSTICS";

/** Upper bounds (exclusive) of the capture latency buckets; the last bucket is open. */
export const UI_CAPTURE_LATENCY_BUCKETS_MS = [250, 500, 1000, 2000, 5000] as const;

export const UI_CAPTURE_FAILURE_KINDS = [
  "timeout",
  "cancelled",
  "http4xx",
  "http5xx",
  "error"
] as const;
export type UiCaptureFailureKind = typeof UI_CAPTURE_FAILURE_KINDS[number];

const CountSchema = z.number().int().nonnegative();
const DurationSchema = z.number().nonnegative();
const VersionSchema = z.string().regex(/^[\w.+-]{1,64}$/);
const TokenSchema = z.string().regex(/^[a-zA-Z][a-zA-Z\d]{0,31}$/);

export const DiagnosticsHostSchema = z.strictObject({
  platform: TokenSchema,
  arch: TokenSchema,
  node: VersionSchema
});

export const UiBackendTelemetrySchema = z.strictObject({
  backend: UiBackendIdSchema,
  captures: CountSchema,
  failures: z.strictObject({
    timeout: CountSchema,
    cancelled: CountSchema,
    http4xx: CountSchema,
    http5xx: CountSchema,
    error: CountSchema
  }),
  totalMs: DurationSchema,
  maxMs: DurationSchema,
  latencyBuckets: z.array(CountSchema).length(UI_CAPTURE_LATENCY_BUCKETS_MS.length + 1),
  sessionRecoveries: CountSchema,
  sessionRecoveryFailures: CountSchema
});
export type UiBackendTelemetry = z.infer<typeof UiBackendTelemetrySchema>;

/**
 * Structured codes a journaled outcome may carry: Replay failure codes plus
 * the Generation-only codes (`ACTION_UNSUPPORTED`, `SNAPSHOT_STALE`, ...).
 */
export const DIAGNOSTIC_OUTCOME_CODES = [
  ...new Set([...FAILURE_CODES, ...GENERATION_ERROR_CODES])
] as [
  (typeof FAILURE_CODES)[number] | (typeof GENERATION_ERROR_CODES)[number],
  ...((typeof FAILURE_CODES)[number] | (typeof GENERATION_ERROR_CODES)[number])[]
];
export const DiagnosticOutcomeCodeSchema = z.enum(DIAGNOSTIC_OUTCOME_CODES);
export type DiagnosticOutcomeCode = z.infer<typeof DiagnosticOutcomeCodeSchema>;

/** One journal line: a finished CLI invocation. */
export const CommandEventSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("command"),
  at: z.iso.datetime(),
  taphoundVersion: VersionSchema,
  host: DiagnosticsHostSchema,
  command: z.string().regex(/^[a-z][a-z-]*(?: [a-z][a-z-]*){0,3}$/),
  flags: z.array(TokenSchema),
  durationMs: DurationSchema,
  exitCode: z.number().int(),
  status: TokenSchema.optional(),
  failureCode: DiagnosticOutcomeCodeSchema.optional(),
  runId: z.string().regex(/^[\w.-]{1,128}$/).optional(),
  ui: z.array(UiBackendTelemetrySchema)
});
export type CommandEvent = z.infer<typeof CommandEventSchema>;

const RunAliasSchema = z.string().regex(/^run#\d+$/);
const ActivityAliasSchema = z.string().regex(/^activity#\d+$/);
const DeviceAliasSchema = z.string().regex(/^device#\d+$/);
const StepResultSchema = z.enum(["passed", "failed", "notRun", "manualRequired"]);

const ActivityCheckSummarySchema = z.strictObject({
  status: StepResultSchema,
  expected: ActivityAliasSchema,
  actual: ActivityAliasSchema.optional()
});

export const StepSummarySchema = z.strictObject({
  index: CountSchema,
  action: z.enum([
    "click",
    "longClick",
    "inputText",
    "swipe",
    "scrollTo",
    "back",
    "wait",
    "bridge"
  ]),
  status: StepResultSchema,
  device: DeviceAliasSchema.optional(),
  durationMs: DurationSchema,
  locator: z.strictObject({
    status: z.enum(["found", "failed", "notRun"]),
    matchedBy: z.enum(["resourceId", "text", "contentDescription", "anchor"]).optional(),
    requestedFields: z.array(z.enum(["resourceId", "text", "contentDescription", "index", "within"])),
    locatorId: z.string().regex(/^[a-f\d]{16}$/).optional(),
    anchorStatus: z.enum(["resolved", "locatorFallback", "failed"]).optional(),
    fallbackUsed: z.boolean()
  }).optional(),
  idle: z.strictObject({
    status: z.enum(["stable", "timeout", "cancelled", "notRun"]),
    polls: CountSchema,
    durationMs: DurationSchema.optional(),
    samplingDurationMs: DurationSchema.optional(),
    strategy: z.enum(["hybrid", "layoutDiff", "frameStats", "structural"]).optional(),
    backend: z.enum(["uiautomator", "androidCli", "gfxFrameStats", "mobileMcp"]).optional(),
    fallbackUsed: z.boolean().optional(),
    frameActivityDetected: z.boolean().optional(),
    lastDiffCount: CountSchema.optional()
  }).optional(),
  activity: z.strictObject({
    before: ActivityCheckSummarySchema,
    after: ActivityCheckSummarySchema
  }).optional(),
  expectation: z.strictObject({
    type: z.enum(["activity", "element", "logcat", "logcatEvent"]),
    status: StepResultSchema,
    code: z.enum(FAILURE_CODES).optional()
  }).optional(),
  scroll: z.strictObject({
    swipesUsed: CountSchema,
    maxSwipes: CountSchema
  }).optional()
});
export type StepSummary = z.infer<typeof StepSummarySchema>;

const LayerStatusSchema = StepResultSchema;

export const RunSummarySchema = z.strictObject({
  run: RunAliasSchema,
  status: z.enum(["passed", "failed", "error", "manualRequired"]),
  durationMs: DurationSchema,
  journey: z.string().regex(/^journey#\d+$/),
  devices: z.array(z.strictObject({
    device: DeviceAliasSchema,
    uiBackend: z.strictObject({
      id: UiBackendIdSchema,
      adapterVersion: VersionSchema,
      engineVersion: VersionSchema.optional()
    }).optional(),
    uiCache: UiCacheTelemetrySchema.optional()
  })),
  tools: z.partialRecord(z.enum(["node", "adb", "android"]), VersionSchema),
  layers: z.strictObject({
    run: LayerStatusSchema,
    structural: LayerStatusSchema,
    activityCheckpoint: LayerStatusSchema,
    explicitExpect: LayerStatusSchema,
    collection: LayerStatusSchema
  }),
  primaryFailure: z.strictObject({
    code: z.enum(FAILURE_CODES),
    phase: TokenSchema,
    stepIndex: CountSchema.optional()
  }).optional(),
  secondaryErrorCodes: z.array(z.enum(FAILURE_CODES)),
  fallbackUsed: z.boolean(),
  logcatEvidence: z.array(z.strictObject({
    device: DeviceAliasSchema,
    droppedLines: CountSchema,
    droppedBytes: CountSchema
  })),
  steps: z.array(StepSummarySchema)
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const DiagnosticsConfigSummarySchema = z.strictObject({
  idle: z.strictObject({
    strategy: z.enum(["hybrid", "layoutDiff", "frameStats", "structural"]),
    pollIntervalMs: CountSchema,
    stablePolls: CountSchema,
    timeoutMs: CountSchema,
    ignoreCursorBlink: z.boolean().optional(),
    ignoreLayoutDrift: z.boolean().optional(),
    deviceProfiles: CountSchema
  }),
  ui: z.strictObject({
    backend: UiBackendSelectionSchema,
    snapshotTimeoutMs: CountSchema.optional(),
    cacheEnabled: z.boolean().optional()
  }).optional(),
  runtime: z.strictObject({
    backend: RuntimeBackendChoiceSchema
  }).optional()
});

export const DiagnosticsBundleSchema = z.strictObject({
  version: z.literal(1),
  generatedAt: z.iso.datetime(),
  taphoundVersion: VersionSchema,
  host: DiagnosticsHostSchema,
  config: DiagnosticsConfigSummarySchema.optional(),
  journal: z.strictObject({
    events: z.array(CommandEventSchema.extend({
      runId: RunAliasSchema.optional()
    })),
    skippedLines: CountSchema
  }),
  runs: z.array(RunSummarySchema)
});
export type DiagnosticsBundle = z.infer<typeof DiagnosticsBundleSchema>;
