import { createHash } from "node:crypto";

import { z } from "zod";

import { FAILURE_CODES } from "./failure.js";
import { KnowledgeIdSchema } from "./knowledge.js";
import { DeviceRoleSchema } from "./journey.js";
import { LocatorSchema } from "./layout.js";
import {
  LogcatEventExpectSchema,
  LogcatEventWindowSchema
} from "./logcat-event.js";
import { UiBackendDescriptorSchema } from "./ui-backend.js";
import { UiCacheTelemetrySchema } from "./ui-cache.js";

const ResultStatusSchema = z.enum(["passed", "failed", "notRun", "manualRequired"]);
const RunStatusSchema = z.enum(["passed", "failed", "error", "manualRequired"]);

export const ReportFailureSchema = z.strictObject({
  code: z.enum(FAILURE_CODES),
  message: z.string().min(1),
  phase: z.string().min(1),
  stepIndex: z.number().int().nonnegative().optional()
});

const AnchorLocatorReportSchema = z.strictObject({
  status: z.enum(["resolved", "locatorFallback", "failed"]),
  resolvedBy: z.strictObject({
    kind: z.enum([
      "composeSemantics",
      "resourceId",
      "contentDescription",
      "visibleText",
      "visualMatch"
    ]),
    confidence: z.enum(["primary", "fallback"])
  }).optional(),
  message: z.string().trim().min(1).optional()
});

const LocatorReportSchema = z.strictObject({
  status: z.enum(["found", "failed", "notRun"]),
  matchedBy: z.enum([
    "resourceId",
    "text",
    "contentDescription",
    "anchor"
  ]).optional(),
  requested: LocatorSchema.optional(),
  anchorId: z.string().trim().min(1).optional(),
  anchor: AnchorLocatorReportSchema.optional(),
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
  durationMs: z.number().nonnegative().optional(),
  samplingDurationMs: z.number().nonnegative().optional(),
  strategy: z.enum(["hybrid", "layoutDiff", "frameStats", "structural"]).optional(),
  backend: z.enum([
    "uiautomator",
    "androidCli",
    "gfxFrameStats",
    "mobileMcp"
  ]).optional(),
  backendId: z.string().trim().min(1).optional(),
  fallbackUsed: z.boolean().optional(),
  frameActivityDetected: z.boolean().optional(),
  lastDiff: z.array(z.unknown()).optional()
});

const ActivityCheckSchema = z.strictObject({
  status: ResultStatusSchema,
  expected: z.string().min(1),
  actual: z.string().min(1).optional()
});

const StepExpectationSchema = z.strictObject({
  type: z.enum(["activity", "element", "logcat", "logcatEvent"]),
  status: ResultStatusSchema,
  code: z.enum(FAILURE_CODES).optional(),
  message: z.string().min(1).optional(),
  logcatEvent: z.strictObject({
    matchedCount: z.number().int().nonnegative(),
    matchedLineSha256: z.string().regex(/^[a-f\d]{64}$/).optional(),
    window: LogcatEventWindowSchema,
    startedAtMs: z.number().nonnegative(),
    requestErrorClass: z.enum(["client", "auth", "network", "server"]).optional()
  }).optional(),
  capture: z.strictObject({
    name: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,31}$/),
    valueType: z.enum(["string", "integer", "identifier"]),
    length: z.number().int().positive().max(128),
    sourceStepIndex: z.number().int().nonnegative(),
    window: LogcatEventWindowSchema,
    startedAtMs: z.number().nonnegative(),
    evidenceSha256: z.string().regex(/^[a-f\d]{64}$/)
  }).optional()
}).superRefine((expectation, context) => {
  if (expectation.capture !== undefined && (
    expectation.type !== "logcatEvent" || expectation.status !== "passed"
    || expectation.logcatEvent?.matchedLineSha256 !== expectation.capture.evidenceSha256
    || expectation.logcatEvent.startedAtMs !== expectation.capture.startedAtMs
  )) {
    context.addIssue({
      code: "custom", path: ["capture"],
      message: "Capture requires a passed digest-bound structured event"
    });
  }
  if (expectation.logcatEvent?.requestErrorClass !== undefined && (
    expectation.logcatEvent.matchedCount !== 1
    || expectation.logcatEvent.matchedLineSha256 === undefined
    || expectation.status !== "passed"
  )) {
    context.addIssue({
      code: "custom", path: ["logcatEvent", "requestErrorClass"],
      message: "Request error class requires one matched digest-bound event"
    });
  }
});

export const StepReportSchema = z.strictObject({
  index: z.number().int().nonnegative(),
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
  status: ResultStatusSchema,
  device: DeviceRoleSchema.optional(),
  replayMode: z.enum(["auto", "manual"]).optional(),
  startedAtMs: z.number().nonnegative(),
  finishedAtMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  locator: LocatorReportSchema.optional(),
  idle: IdleReportSchema.optional(),
  scroll: z.strictObject({
    swipesUsed: z.number().int().nonnegative(),
    maxSwipes: z.number().int().positive()
  }).optional(),
  activity: z.strictObject({
    before: ActivityCheckSchema,
    after: ActivityCheckSchema
  }).optional(),
  expectation: StepExpectationSchema.optional(),
  marker: z.strictObject({
    id: KnowledgeIdSchema,
    startedAtMs: z.number().nonnegative()
  }).optional(),
  logcatPath: z.string().min(1).optional()
});

export const CheckpointConditionReportSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("activity"),
    status: z.enum(["passed", "failed", "unresolved"]),
    expected: z.string().trim().min(1),
    actual: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1).optional(),
    startedAtMs: z.number().nonnegative().optional(),
    matchedAtMs: z.number().nonnegative().optional(),
    evidenceRef: z.string().trim().min(1).optional()
  }),
  z.strictObject({
    kind: z.literal("screen"),
    status: z.enum(["passed", "failed", "unresolved"]),
    expected: KnowledgeIdSchema,
    actual: KnowledgeIdSchema.optional(),
    message: z.string().trim().min(1).optional(),
    startedAtMs: z.number().nonnegative().optional(),
    matchedAtMs: z.number().nonnegative().optional(),
    evidenceRef: z.string().trim().min(1).optional()
  }),
  z.strictObject({
    kind: z.enum(["visibleElement", "absentElement"]),
    status: z.enum(["passed", "failed", "unresolved"]),
    locator: LocatorSchema,
    message: z.string().trim().min(1).optional(),
    startedAtMs: z.number().nonnegative().optional(),
    matchedAtMs: z.number().nonnegative().optional(),
    evidenceRef: z.string().trim().min(1).optional()
  }),
  z.strictObject({
    kind: z.literal("logcatEvent"),
    status: z.enum(["passed", "failed", "unresolved"]),
    expect: LogcatEventExpectSchema.omit({ timeoutMs: true }),
    matchedCount: z.number().int().nonnegative(),
    matchedLineSha256: z.string().regex(/^[a-f\d]{64}$/).optional(),
    startedAtMs: z.number().nonnegative(),
    matchedAtMs: z.number().nonnegative().optional(),
    evidenceRef: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1).optional()
  })
]);

export const CheckpointReportSchema = z.strictObject({
  id: KnowledgeIdSchema,
  stepIndex: z.number().int().nonnegative().optional(),
  status: z.enum(["passed", "failed", "unresolved"]),
  conditions: z.array(CheckpointConditionReportSchema).min(1)
}).superRefine((checkpoint, context) => {
  for (const [index, condition] of checkpoint.conditions.entries()) {
    if (condition.kind === "logcatEvent" && condition.status === "passed"
      && (condition.matchedCount !== 1
        || condition.matchedLineSha256 === undefined
        || condition.matchedAtMs === undefined
        || condition.evidenceRef === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["conditions", index],
        message: "Passed Logcat events need exactly one digest-bound artifact match"
      });
    }
  }
  const status = checkpoint.conditions.some((condition) => condition.status === "failed")
    ? "failed"
    : checkpoint.conditions.some((condition) => condition.status === "unresolved")
      ? "unresolved"
      : "passed";
  if (checkpoint.status !== status) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Checkpoint status must reflect all condition results"
    });
  }
});

const LayersSchema = z.strictObject({
  run: ResultStatusSchema,
  structural: ResultStatusSchema,
  activityCheckpoint: ResultStatusSchema,
  explicitExpect: ResultStatusSchema,
  collection: ResultStatusSchema
});

const ArtifactRolePathSchema = z.strictObject({
  role: DeviceRoleSchema,
  path: z.string().min(1)
});

const ArtifactsSchema = z.strictObject({
  directory: z.string().min(1),
  report: z.string().min(1),
  summary: z.string().min(1),
  screenshots: z.array(ArtifactRolePathSchema),
  uiHierarchies: z.array(ArtifactRolePathSchema).optional(),
  logcats: z.array(ArtifactRolePathSchema),
  stepLogs: z.array(z.string().min(1))
});

const ReportFields = {
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
  layers: LayersSchema,
  steps: z.array(StepReportSchema),
  logcatEvidence: z.array(z.strictObject({
    role: DeviceRoleSchema,
    status: z.literal("incomplete"),
    droppedLines: z.number().int().positive(),
    droppedBytes: z.number().int().positive(),
    lastDroppedAtMs: z.number().nonnegative().optional()
  })).optional(),
  checkpoints: z.array(CheckpointReportSchema).optional(),
  screens: z.array(z.strictObject({
    screen: z.string().trim().min(1),
    status: z.enum(["matched", "ambiguous", "unresolved"])
  })).optional(),
  artifacts: ArtifactsSchema,
  primaryFailure: ReportFailureSchema.optional(),
  secondaryErrors: z.array(ReportFailureSchema),
  fallbackUsed: z.boolean()
};

const ReportDeviceSchema = z.strictObject({
  role: DeviceRoleSchema,
  deviceSerial: z.string().min(1),
  uiBackend: UiBackendDescriptorSchema.optional(),
  uiCache: UiCacheTelemetrySchema.optional()
});

export const TapHoundReportV4Schema = z.strictObject({
  schemaVersion: z.literal(4),
  ...ReportFields,
  environment: z.strictObject({
    devices: z.array(ReportDeviceSchema).min(1),
    tools: z.record(z.string(), z.string())
  })
}).superRefine((report, context) => {
  const roles = new Set(report.environment.devices.map(
    (device) => device.role
  ));
  if (roles.size !== report.environment.devices.length) {
    context.addIssue({
      code: "custom",
      message: "Device roles must be unique within a report"
    });
    return;
  }
  const unknownArtifactRole = [
    ...report.artifacts.screenshots,
    ...(report.artifacts.uiHierarchies ?? []),
    ...report.artifacts.logcats
  ].some((entry) => !roles.has(entry.role));
  if (unknownArtifactRole) {
    context.addIssue({
      code: "custom",
      message: "Artifacts reference an unknown device role"
    });
  }
});

export const TapHoundReportSchema = TapHoundReportV4Schema;

export type ReportFailure = z.infer<typeof ReportFailureSchema>;
export type StepReport = z.infer<typeof StepReportSchema>;
export type CheckpointReport = z.infer<typeof CheckpointReportSchema>;
export type TapHoundReportV4 = z.infer<typeof TapHoundReportV4Schema>;
export type TapHoundReport = TapHoundReportV4;

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
