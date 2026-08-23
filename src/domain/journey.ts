import { z } from "zod";

import { LocatorSchema } from "./layout.js";

const QualifiedActivitySchema = z.string().regex(
  /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/,
  "Activity checkpoint must be fully qualified"
);

const QualifiedNameSchema = z.string().regex(
  /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/,
  "Value must be fully qualified"
);

export const ActivityCheckpointSchema = z.strictObject({
  before: QualifiedActivitySchema,
  after: QualifiedActivitySchema
});

const ActivityExpectSchema = z.strictObject({
  type: z.literal("activity"),
  value: QualifiedActivitySchema,
  packageName: QualifiedNameSchema.optional(),
  timeoutMs: z.number().int().positive()
});

const ElementExpectSchema = z.strictObject({
  type: z.literal("element"),
  locator: LocatorSchema,
  packageName: QualifiedNameSchema.optional(),
  timeoutMs: z.number().int().positive()
});

const LogcatExpectSchema = z.strictObject({
  type: z.literal("logcat"),
  tag: z.string().min(1),
  level: z.enum(["V", "D", "I", "W", "E", "F", "A"]).optional(),
  pattern: z.string().min(1),
  match: z.enum(["literal", "regex"]).default("literal"),
  packageName: QualifiedNameSchema.optional(),
  timeoutMs: z.number().int().positive()
}).superRefine((expectation, context) => {
  if (expectation.match === "regex") {
    try {
      new RegExp(expectation.pattern);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["pattern"],
        message: "pattern must be a valid regular expression"
      });
    }
  }
});

export const ExpectSchema = z.discriminatedUnion("type", [
  ActivityExpectSchema,
  ElementExpectSchema,
  LogcatExpectSchema
]);

const ExternalCommonStepShape = {
  expectedActivity: QualifiedActivitySchema,
  expect: ExpectSchema.optional()
};

const ExternalClickStepSchema = z.strictObject({
  action: z.literal("click"),
  locator: LocatorSchema,
  ...ExternalCommonStepShape
});

const ExternalLongClickStepSchema = z.strictObject({
  action: z.literal("longClick"),
  locator: LocatorSchema,
  durationMs: z.number().int().positive().default(800),
  ...ExternalCommonStepShape
});

const ExternalInputTextStepSchema = z.strictObject({
  action: z.literal("inputText"),
  text: z.string().min(1),
  ...ExternalCommonStepShape
});

const ExternalSwipeStepSchema = z.strictObject({
  action: z.literal("swipe"),
  locator: LocatorSchema,
  direction: z.enum(["up", "down", "left", "right"]),
  distancePercent: z.number().positive().max(1).default(0.6),
  durationMs: z.number().int().positive().default(300),
  ...ExternalCommonStepShape
});

const ExternalScrollToStepSchema = z.strictObject({
  action: z.literal("scrollTo"),
  locator: LocatorSchema,
  container: LocatorSchema,
  direction: z.enum(["up", "down", "left", "right"]),
  maxSwipes: z.number().int().positive().max(30).default(20),
  distancePercent: z.number().positive().max(1).default(0.6),
  durationMs: z.number().int().positive().default(300),
  ...ExternalCommonStepShape
});

const ExternalBackStepSchema = z.strictObject({
  action: z.literal("back"),
  ...ExternalCommonStepShape
});

const ExternalWaitStepSchema = z.strictObject({
  action: z.literal("wait"),
  ...ExternalCommonStepShape
});

export const ExternalStepSchema = z.discriminatedUnion("action", [
  ExternalClickStepSchema,
  ExternalLongClickStepSchema,
  ExternalInputTextStepSchema,
  ExternalSwipeStepSchema,
  ExternalScrollToStepSchema,
  ExternalBackStepSchema,
  ExternalWaitStepSchema
]).superRefine((step, context) => {
  const stepRecord = step as Record<string, unknown>;
  const locator = stepRecord.locator as
    | { resourceId?: unknown; evidence?: unknown }
    | undefined;
  if (
    locator !== undefined
    && locator.resourceId === undefined
    && locator.evidence === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["locator"],
      message: "External step locator must have resourceId or evidence for determinism"
    });
  }
  if (step.expect?.type === "element") {
    const expectLocator = step.expect.locator as {
      resourceId?: unknown;
      evidence?: unknown;
    };
    if (
      expectLocator.resourceId === undefined
      && expectLocator.evidence === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["expect", "locator"],
        message: "External element expectation locator must have resourceId or evidence for determinism"
      });
    }
  }
});

const CommonStepShape = {
  activity: ActivityCheckpointSchema,
  expect: ExpectSchema.optional(),
  replayMode: z.enum(["auto", "manual"]).optional()
};

export const BridgeScenarioSchema = z.enum([
  "photoCapture",
  "pickImage",
  "pickFile",
  "custom"
]);

export const AnnotatedLabelFallbackSchema = z.strictObject({
  type: z.literal("annotatedLabel"),
  label: z.string().regex(/^#\d+$/, "Fallback label must use Android CLI #number format")
});

const ClickStepSchema = z.strictObject({
  action: z.literal("click"),
  locator: LocatorSchema,
  fallback: AnnotatedLabelFallbackSchema.optional(),
  ...CommonStepShape
});

const LongClickStepSchema = z.strictObject({
  action: z.literal("longClick"),
  locator: LocatorSchema,
  durationMs: z.number().int().positive().default(800),
  fallback: AnnotatedLabelFallbackSchema.optional(),
  ...CommonStepShape
});

const InputTextStepSchema = z.strictObject({
  action: z.literal("inputText"),
  text: z.string().min(1),
  ...CommonStepShape
});

const SwipeStepSchema = z.strictObject({
  action: z.literal("swipe"),
  locator: LocatorSchema,
  direction: z.enum(["up", "down", "left", "right"]),
  distancePercent: z.number().positive().max(1).default(0.6),
  durationMs: z.number().int().positive().default(300),
  ...CommonStepShape
});

const ScrollToStepSchema = z.strictObject({
  action: z.literal("scrollTo"),
  locator: LocatorSchema,
  container: LocatorSchema,
  direction: z.enum(["up", "down", "left", "right"]),
  maxSwipes: z.number().int().positive().max(30).default(20),
  distancePercent: z.number().positive().max(1).default(0.6),
  durationMs: z.number().int().positive().default(300),
  ...CommonStepShape
});

const BackStepSchema = z.strictObject({
  action: z.literal("back"),
  ...CommonStepShape
});

const WaitStepSchema = z.strictObject({
  action: z.literal("wait"),
  ...CommonStepShape
});

const BridgeStepSchema = z.strictObject({
  action: z.literal("bridge"),
  scenario: BridgeScenarioSchema,
  description: z.string().min(1),
  triggerLocator: LocatorSchema,
  escapedPackageName: QualifiedNameSchema.optional(),
  returnTimeoutMs: z.number().int().positive(),
  flow: z.string().trim().min(1).optional(),
  externalSteps: z.array(ExternalStepSchema).optional(),
  escapeTimeoutMs: z.number().int().positive().optional(),
  ...CommonStepShape,
  replayMode: z.enum(["auto", "manual"]).default("manual")
}).superRefine((step, context) => {
  const hasFlow = step.flow !== undefined;
  const hasExternalSteps = step.externalSteps !== undefined;

  if (hasFlow && hasExternalSteps) {
    context.addIssue({
      code: "custom",
      path: ["flow"],
      message: "flow and externalSteps are mutually exclusive"
    });
  }

  if (step.replayMode === "auto" && !hasFlow && !hasExternalSteps) {
    context.addIssue({
      code: "custom",
      path: ["replayMode"],
      message: "replayMode 'auto' requires flow or externalSteps"
    });
  }

  if (
    (hasFlow || hasExternalSteps)
    && step.escapedPackageName === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["escapedPackageName"],
      message: "escapedPackageName is required when flow or externalSteps are present"
    });
  }
});

export const JourneyStepSchema = z.discriminatedUnion("action", [
  ClickStepSchema,
  LongClickStepSchema,
  InputTextStepSchema,
  SwipeStepSchema,
  ScrollToStepSchema,
  BackStepSchema,
  WaitStepSchema,
  BridgeStepSchema
]);

export const JourneySchema = z.strictObject({
  version: z.literal(1),
  name: z.string().trim().min(1),
  steps: z.array(JourneyStepSchema).min(1)
});

export type ActivityCheckpoint = z.infer<typeof ActivityCheckpointSchema>;
export type AnnotatedLabelFallback = z.infer<
  typeof AnnotatedLabelFallbackSchema
>;
export type BridgeScenario = z.infer<typeof BridgeScenarioSchema>;
export type Expectation = z.infer<typeof ExpectSchema>;
export type ExternalStep = z.infer<typeof ExternalStepSchema>;
export type JourneyStep = z.infer<typeof JourneyStepSchema>;
export type Journey = z.infer<typeof JourneySchema>;
