import { z } from "zod";

import { KnowledgeIdSchema } from "./knowledge.js";

const EventValueSchema = z.union([
  z.string().max(512),
  z.number(),
  z.boolean()
]);

export const BindingNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,31}$/);
export const BindingReferenceSchema = z.string().regex(
  /^\$\{[a-z][a-zA-Z0-9_]{0,31}\}$/
);

export const EventCaptureSchema = z.strictObject({
  name: BindingNameSchema,
  field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/).optional(),
  group: z.literal("correlation").optional(),
  valueType: z.enum(["string", "integer", "identifier"])
}).superRefine((capture, context) => {
  if ((capture.field === undefined) === (capture.group === undefined)) {
    context.addIssue({
      code: "custom", message: "Capture requires exactly one field or correlation group"
    });
  }
});

export const LogcatEventWindowSchema = z.discriminatedUnion("from", [
  z.strictObject({ from: z.literal("stepStart") }),
  z.strictObject({ from: z.literal("runStart") }),
  z.strictObject({ from: z.literal("marker"), markerId: KnowledgeIdSchema })
]);

export const LogcatEventExpectSchema = z.strictObject({
  type: z.literal("logcatEvent"),
  tag: z.string().trim().min(1),
  event: z.string().trim().min(1),
  fields: z.record(z.string().trim().min(1), EventValueSchema).default({}),
  correlation: z.strictObject({
    key: z.string().trim().min(1),
    value: z.union([EventValueSchema, BindingReferenceSchema])
  }).optional(),
  capture: EventCaptureSchema.optional(),
  unique: z.literal(true).default(true),
  window: LogcatEventWindowSchema.default({ from: "stepStart" }),
  timeoutMs: z.number().int().positive()
});

export type LogcatEventExpect = z.infer<typeof LogcatEventExpectSchema>;
export type LogcatEventWindow = z.infer<typeof LogcatEventWindowSchema>;
export type EventCapture = z.infer<typeof EventCaptureSchema>;
