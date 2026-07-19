import { z } from "zod";

import { LocatorSchema } from "./layout.js";

const QualifiedActivitySchema = z.string().regex(
  /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/,
  "Activity checkpoint must be fully qualified"
);

export const ActivityCheckpointSchema = z.strictObject({
  before: QualifiedActivitySchema,
  after: QualifiedActivitySchema
});

const ActivityExpectSchema = z.strictObject({
  type: z.literal("activity"),
  value: QualifiedActivitySchema,
  timeoutMs: z.number().int().positive()
});

const ElementExpectSchema = z.strictObject({
  type: z.literal("element"),
  locator: LocatorSchema,
  timeoutMs: z.number().int().positive()
});

const LogcatExpectSchema = z.strictObject({
  type: z.literal("logcat"),
  tag: z.string().min(1),
  level: z.enum(["V", "D", "I", "W", "E", "F", "A"]).optional(),
  pattern: z.string().min(1),
  match: z.enum(["literal", "regex"]).default("literal"),
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

const CommonStepShape = {
  activity: ActivityCheckpointSchema,
  expect: ExpectSchema.optional()
};

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

const BackStepSchema = z.strictObject({
  action: z.literal("back"),
  ...CommonStepShape
});

const WaitStepSchema = z.strictObject({
  action: z.literal("wait"),
  ...CommonStepShape
});

export const JourneyStepSchema = z.discriminatedUnion("action", [
  ClickStepSchema,
  LongClickStepSchema,
  InputTextStepSchema,
  SwipeStepSchema,
  BackStepSchema,
  WaitStepSchema
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
export type Expectation = z.infer<typeof ExpectSchema>;
export type JourneyStep = z.infer<typeof JourneyStepSchema>;
export type Journey = z.infer<typeof JourneySchema>;
