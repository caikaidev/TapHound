import { z } from "zod";

const PackageNameSchema = z.string().regex(
  /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/,
  "packageName must be a qualified Java package"
);

const ActivityNameSchema = z.string().refine(
  (value) => (
    /^\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value)
    || /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/.test(value)
  ),
  "activity must be relative with a leading dot or fully qualified"
);

export const AprConfigSchema = z.strictObject({
  version: z.literal(1),
  build: z.strictObject({
    task: z.string().trim().min(1)
  }),
  artifact: z.strictObject({
    target: z.string().trim().min(1),
    variant: z.string().trim().min(1)
  }),
  run: z.strictObject({
    packageName: PackageNameSchema,
    activity: ActivityNameSchema
  }),
  idle: z.strictObject({
    pollIntervalMs: z.number().int().positive(),
    stablePolls: z.number().int().positive(),
    timeoutMs: z.number().int().positive()
  }),
  artifactsDir: z.string().trim().min(1)
});

export type AprConfig = z.infer<typeof AprConfigSchema>;
