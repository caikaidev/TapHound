import { z } from "zod";

import { ExternalStepSchema } from "./journey.js";
import { FlowNameSchema, IncludesSchema } from "./journey-composition.js";

const QualifiedActivitySchema = z.string().regex(
  /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/,
  "Activity checkpoint must be fully qualified"
);

const QualifiedNameSchema = z.string().regex(
  /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/,
  "Value must be fully qualified"
);

export const ExternalFlowSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("externalFlow"),
  name: FlowNameSchema,
  description: z.string().min(1),
  escapedPackageName: QualifiedNameSchema,
  expectedEscapeActivity: QualifiedActivitySchema.optional(),
  includes: IncludesSchema,
  steps: z.array(ExternalStepSchema).min(1)
});

export type ExternalStep = z.infer<typeof ExternalStepSchema>;
export type ExternalFlow = z.infer<typeof ExternalFlowSchema>;
