import { z } from "zod";

import { ExpectSchema } from "./journey.js";
import { LocatorSchema } from "./layout.js";

const QualifiedActivitySchema = z.string().regex(
  /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/,
  "Activity checkpoint must be fully qualified"
);

const ProposedActivitySchema = z.strictObject({
  before: QualifiedActivitySchema
});

const CommonStepShape = {
  activity: ProposedActivitySchema,
  expect: ExpectSchema.optional()
};

const ClickStepSchema = z.strictObject({
  action: z.literal("click"),
  locator: LocatorSchema,
  ...CommonStepShape
});

const LongClickStepSchema = z.strictObject({
  action: z.literal("longClick"),
  locator: LocatorSchema,
  durationMs: z.number().int().positive().default(800),
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

export const ProposedStepSchema = z.discriminatedUnion("action", [
  ClickStepSchema,
  LongClickStepSchema,
  InputTextStepSchema,
  SwipeStepSchema,
  ScrollToStepSchema,
  BackStepSchema,
  WaitStepSchema
]);

export type ProposedStep = z.infer<typeof ProposedStepSchema>;
