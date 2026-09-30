import { z } from "zod";

import { KnowledgeIdSchema } from "./knowledge.js";
import { CheckpointDefinitionSchema } from "./checkpoint.js";
import { LocatorSchema } from "./layout.js";
import { LogcatEventExpectSchema } from "./logcat-event.js";
import { bindingName, checkBindingReferences } from "./binding-reference.js";

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

export const DeviceRoleSchema = z.string().regex(
  /^[a-z][a-zA-Z\d]*$/,
  "Device role must start with a lowercase letter and contain only letters and digits"
);

export const DeviceDeclarationSchema = z.strictObject({
  role: DeviceRoleSchema,
  description: z.string().trim().min(1).optional()
});

export const DEFAULT_DEVICE_ROLE = "default";

const ActivityExpectSchema = z.strictObject({
  type: z.literal("activity"),
  value: QualifiedActivitySchema,
  packageName: QualifiedNameSchema.optional(),
  timeoutMs: z.number().int().positive()
});

const ElementExpectSchema = z.strictObject({
  type: z.literal("element"),
  locator: LocatorSchema,
  enabled: z.boolean().optional(),
  clickable: z.boolean().optional(),
  absent: z.boolean().optional(),
  packageName: QualifiedNameSchema.optional(),
  timeoutMs: z.number().int().positive()
}).superRefine((expectation, context) => {
  if (
    expectation.absent === true
    && (expectation.enabled !== undefined || expectation.clickable !== undefined)
  ) {
    context.addIssue({
      code: "custom",
      path: ["absent"],
      message: "absent element expectations cannot combine enabled or clickable predicates"
    });
  }
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
  LogcatExpectSchema,
  LogcatEventExpectSchema
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
  checkBindingReferences(step, context, []);
  if (step.expect?.type === "logcatEvent"
    && step.expect.capture !== undefined) {
    context.addIssue({
      code: "custom", path: ["expect", "capture"],
      message: "External steps cannot capture replay bindings"
    });
  }
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
  device: DeviceRoleSchema.optional(),
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

export const AnchorLocatorTarget = {
  anchor: KnowledgeIdSchema.optional(),
  locator: LocatorSchema.optional()
};

const AnchorTargetRefine = (
  step: { anchor?: string | undefined; locator?: unknown },
  context: z.RefinementCtx
): void => {
  if (step.anchor === undefined && step.locator === undefined) {
    context.addIssue({
      code: "custom",
      path: ["locator"],
      message: "A step must provide a semantic anchor or a runtime locator"
    });
  }
};

/**
 * `element` touches the located element itself even though neither it nor
 * an ancestor reports the action capability (RecyclerView item-touch
 * listeners, WebView DOM nodes). Without the capability proof, the step
 * must prove its effect with an outcome instead.
 */
export const TouchPolicySchema = z.literal("element");
export type TouchPolicy = z.infer<typeof TouchPolicySchema>;

const TouchPolicyRefine = (
  step: {
    touchPolicy?: TouchPolicy | undefined;
    anchor?: string | undefined;
    fallback?: unknown;
    expect?: { type: string } | undefined;
    activity: { before: string; after: string };
  },
  context: z.RefinementCtx
): void => {
  if (step.touchPolicy === undefined) return;
  if (step.anchor !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["touchPolicy"],
      message: "touchPolicy element requires a runtime locator, not an anchor"
    });
  }
  if (step.fallback !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["touchPolicy"],
      message: "touchPolicy element cannot combine an annotated fallback"
    });
  }
  if (
    step.expect?.type !== "element"
    && step.expect?.type !== "activity"
    && step.activity.after === step.activity.before
  ) {
    context.addIssue({
      code: "custom",
      path: ["touchPolicy"],
      message: "touchPolicy element requires an element or activity expect, or an Activity change, to prove the touch took effect"
    });
  }
};

const ClickStepSchema = z.strictObject({
  action: z.literal("click"),
  ...AnchorLocatorTarget,
  touchPolicy: TouchPolicySchema.optional(),
  fallback: AnnotatedLabelFallbackSchema.optional(),
  ...CommonStepShape
}).superRefine((step, context) => {
  AnchorTargetRefine(step, context);
  TouchPolicyRefine(step, context);
});

const LongClickStepSchema = z.strictObject({
  action: z.literal("longClick"),
  ...AnchorLocatorTarget,
  touchPolicy: TouchPolicySchema.optional(),
  durationMs: z.number().int().positive().default(800),
  fallback: AnnotatedLabelFallbackSchema.optional(),
  ...CommonStepShape
}).superRefine((step, context) => {
  AnchorTargetRefine(step, context);
  TouchPolicyRefine(step, context);
});

const InputTextStepSchema = z.strictObject({
  action: z.literal("inputText"),
  text: z.string().min(1),
  anchor: KnowledgeIdSchema.optional(),
  ...CommonStepShape
});

const SwipeStepSchema = z.strictObject({
  action: z.literal("swipe"),
  ...AnchorLocatorTarget,
  direction: z.enum(["up", "down", "left", "right"]),
  distancePercent: z.number().positive().max(1).default(0.6),
  durationMs: z.number().int().positive().default(300),
  ...CommonStepShape
}).superRefine(AnchorTargetRefine);

const ScrollToStepSchema = z.strictObject({
  action: z.literal("scrollTo"),
  ...AnchorLocatorTarget,
  container: LocatorSchema,
  direction: z.enum(["up", "down", "left", "right"]),
  maxSwipes: z.number().int().positive().max(30).default(20),
  distancePercent: z.number().positive().max(1).default(0.6),
  durationMs: z.number().int().positive().default(300),
  ...CommonStepShape
}).superRefine(AnchorTargetRefine);

const BackStepSchema = z.strictObject({
  action: z.literal("back"),
  ...CommonStepShape
});

const WaitStepSchema = z.strictObject({
  action: z.literal("wait"),
  markerId: KnowledgeIdSchema.optional(),
  until: z.strictObject({ element: LocatorSchema }).optional(),
  timeoutMs: z.number().int().positive().optional(),
  ...CommonStepShape
}).superRefine((step, context) => {
  if ((step.until === undefined) !== (step.timeoutMs === undefined)) {
    context.addIssue({
      code: "custom",
      path: [step.until === undefined ? "until" : "timeoutMs"],
      message: "wait until and timeoutMs must be provided together"
    });
  }
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
]).superRefine((step, context) => {
  if (step.expect?.type === "logcatEvent"
    && step.expect.capture?.group === "correlation"
    && step.expect.correlation === undefined) {
    context.addIssue({
      code: "custom", path: ["expect", "capture", "group"],
      message: "Correlation Capture requires a declared correlation key"
    });
  }
  checkBindingReferences(step, context, [
    ...(step.action === "inputText" ? [["text"]] : []),
    ...(step.action === "click" || step.action === "longClick"
      || step.action === "swipe" || step.action === "scrollTo"
      ? [["locator", "text"]] : []),
    ["expect", "correlation", "value"]
  ]);
});

export const JourneySchema = z.strictObject({
  version: z.literal(2),
  name: z.string().trim().min(1),
  devices: z.array(DeviceDeclarationSchema).min(1),
  steps: z.array(JourneyStepSchema).min(1),
  checkpoints: z.array(CheckpointDefinitionSchema).optional()
}).superRefine((journey, context) => {
  const captures = new Map<string, { index: number; role: string }>();
  const soleRoleForCapture = journey.devices[0]?.role ?? DEFAULT_DEVICE_ROLE;
  for (const [index, step] of journey.steps.entries()) {
    const role = step.device ?? soleRoleForCapture;
    const allowed = [
      ...(step.action === "inputText" ? [["text"]] : []),
      ...(step.action === "click" || step.action === "longClick"
        || step.action === "swipe" || step.action === "scrollTo"
        ? [["locator", "text"]] : []),
      ["expect", "correlation", "value"]
    ];
    const refs = [
      ...(step.action === "inputText" ? [step.text] : []),
      ...("locator" in step && step.locator !== undefined
        ? [step.locator.text] : []),
      ...(step.expect?.type === "logcatEvent"
        ? [step.expect.correlation?.value] : [])
    ];
    for (const ref of refs) {
      if (typeof ref !== "string" || bindingName(ref) === undefined) continue;
      const capture = captures.get(bindingName(ref) ?? "");
      if (capture === undefined || capture.index >= index || capture.role !== role) {
        context.addIssue({
          code: "custom", path: ["steps", index],
          message: "Binding must come from an earlier unique event on the same device"
        });
      }
    }
    // The step schema is also used independently by generation and recording.
    checkBindingReferences(step, context, allowed.map((path) => ["steps", index, ...path]),
      ["steps", index]);
    if (step.expect?.type !== "logcatEvent" || step.expect.capture === undefined) continue;
    const name = step.expect.capture.name;
    if (captures.has(name) || captures.size >= 16) {
      context.addIssue({
        code: "custom", path: ["steps", index, "expect", "capture"],
        message: "Capture names must be unique and limited to 16 per Journey"
      });
    } else {
      captures.set(name, { index, role });
    }
  }
  for (const [index, checkpoint] of (journey.checkpoints ?? []).entries()) {
    checkBindingReferences(checkpoint, context, [], ["checkpoints", index]);
    for (const condition of checkpoint.expect.allOf) {
      if (condition.kind === "logcatEvent" && condition.expect.capture !== undefined) {
        context.addIssue({
          code: "custom", path: ["checkpoints", index],
          message: "Checkpoint conditions cannot capture replay bindings"
        });
      }
    }
  }
  const markerIndexes = new Map<string, number>();
  for (const [index, step] of journey.steps.entries()) {
    if (step.action !== "wait" || step.markerId === undefined) {
      continue;
    }
    if (markerIndexes.has(step.markerId)) {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "markerId"],
        message: `Duplicate marker id: ${step.markerId}`
      });
    }
    markerIndexes.set(step.markerId, index);
  }
  for (const [index, checkpoint] of (journey.checkpoints ?? []).entries()) {
    for (const condition of checkpoint.expect.allOf) {
      if (condition.kind !== "logcatEvent"
        || condition.expect.window.from !== "marker") {
        continue;
      }
      const markerIndex = markerIndexes.get(condition.expect.window.markerId);
      if (markerIndex === undefined
        || (checkpoint.stepIndex !== undefined && markerIndex > checkpoint.stepIndex)) {
        context.addIssue({
          code: "custom",
          path: ["checkpoints", index, "expect", "allOf"],
          message: "Checkpoint event marker must be declared by a preceding wait step"
        });
      }
    }
  }
  for (const [index, step] of journey.steps.entries()) {
    if (step.expect?.type !== "logcatEvent" || step.expect.window.from !== "marker") {
      continue;
    }
    const markerIndex = markerIndexes.get(step.expect.window.markerId);
    if (markerIndex === undefined || markerIndex > index) {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "expect", "window"],
        message: "Logcat event marker must refer to this or an earlier wait step"
      });
    }
  }
  const checkpointIds = new Set<string>();
  for (const [index, checkpoint] of (journey.checkpoints ?? []).entries()) {
    if (checkpointIds.has(checkpoint.id)) {
      context.addIssue({
        code: "custom",
        path: ["checkpoints", index, "id"],
        message: `Duplicate Checkpoint id: ${checkpoint.id}`
      });
    }
    checkpointIds.add(checkpoint.id);
    if (
      checkpoint.stepIndex !== undefined
      && checkpoint.stepIndex >= journey.steps.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["checkpoints", index, "stepIndex"],
        message: "Checkpoint stepIndex must reference a Journey step"
      });
    }
  }
  const roles = new Set<string>();
  for (const [index, device] of journey.devices.entries()) {
    if (roles.has(device.role)) {
      context.addIssue({
        code: "custom",
        path: ["devices", index, "role"],
        message: "Device roles must be unique"
      });
    }
    roles.add(device.role);
  }
  const multiDevice = journey.devices.length > 1;
  const usedRoles = new Set<string>();
  const soleRole = journey.devices[0]?.role ?? DEFAULT_DEVICE_ROLE;
  for (const [index, step] of journey.steps.entries()) {
    const device = (step as { device?: string }).device;
    if (device === undefined) {
      if (multiDevice) {
        context.addIssue({
          code: "custom",
          path: ["steps", index],
          message: "Every step must declare its device when multiple devices are declared"
        });
      } else {
        usedRoles.add(soleRole);
      }
      continue;
    }
    if (!roles.has(device)) {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "device"],
        message: "Step references an undeclared device role"
      });
      continue;
    }
    usedRoles.add(device);
  }
  for (const [index, device] of journey.devices.entries()) {
    if (!usedRoles.has(device.role)) {
      context.addIssue({
        code: "custom",
        path: ["devices", index, "role"],
        message: "Device role is declared but never used"
      });
    }
  }
});

export type ActivityCheckpoint = z.infer<typeof ActivityCheckpointSchema>;
export type AnnotatedLabelFallback = z.infer<
  typeof AnnotatedLabelFallbackSchema
>;
export type BridgeScenario = z.infer<typeof BridgeScenarioSchema>;
export type DeviceDeclaration = z.infer<typeof DeviceDeclarationSchema>;
export type DeviceRole = z.infer<typeof DeviceRoleSchema>;
export type Expectation = z.infer<typeof ExpectSchema>;
export type ExternalStep = z.infer<typeof ExternalStepSchema>;
export type JourneyStep = z.infer<typeof JourneyStepSchema>;
export type Journey = z.infer<typeof JourneySchema>;
