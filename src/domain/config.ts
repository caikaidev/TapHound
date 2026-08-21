import { z } from "zod";

import { DEFAULT_ARTIFACTS_DIR } from "./workspace.js";

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

export const TapHoundConfigSchema = z.strictObject({
  version: z.literal(1),
  run: z.strictObject({
    packageName: PackageNameSchema,
    activity: ActivityNameSchema
  }),
  idle: z.strictObject({
    strategy: z.enum(["hybrid", "layoutDiff", "frameStats"]).default("hybrid"),
    pollIntervalMs: z.number().int().positive(),
    stablePolls: z.number().int().positive(),
    timeoutMs: z.number().int().positive()
  }),
  artifactsDir: z.string().trim().min(1).default(DEFAULT_ARTIFACTS_DIR)
});

export type TapHoundConfig = z.infer<typeof TapHoundConfigSchema>;
