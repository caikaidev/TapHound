import { z } from "zod";

import {
  DEFAULT_ARTIFACTS_DIR,
  isInvalidRelativeArtifactDirectory
} from "./workspace.js";
import { RuntimeBackendChoiceSchema } from "./runtime.js";
import { UiBackendSelectionSchema } from "./ui-backend.js";

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

export const DeviceIdleProfileMatchSchema = z.strictObject({
  manufacturer: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  sdkLevel: z.number().int().positive().optional()
});

export const DeviceIdleProfileSchema = z.strictObject({
  match: DeviceIdleProfileMatchSchema,
  strategy: z.enum(["hybrid", "layoutDiff", "frameStats", "structural"]).optional(),
  pollIntervalMs: z.number().int().positive().optional(),
  stablePolls: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  ignoreCursorBlink: z.boolean().optional(),
  ignoreLayoutDrift: z.boolean().optional()
}).superRefine((profile, context) => {
  if (
    profile.match.manufacturer === undefined
    && profile.match.model === undefined
    && profile.match.sdkLevel === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["match"],
      message: "A device idle profile must match at least one device attribute"
    });
  }
});

export const IdlePolicySchema = z.strictObject({
  strategy: z.enum(["hybrid", "layoutDiff", "frameStats", "structural"]).default("hybrid"),
  pollIntervalMs: z.number().int().positive(),
  stablePolls: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  ignoreCursorBlink: z.boolean().optional(),
  ignoreLayoutDrift: z.boolean().optional(),
  deviceProfiles: z.array(DeviceIdleProfileSchema).optional()
});

export const TapHoundConfigSchema = z.strictObject({
  version: z.literal(1),
  run: z.strictObject({
    packageName: PackageNameSchema,
    activity: ActivityNameSchema
  }),
  idle: IdlePolicySchema,
  ui: z.strictObject({
    backend: UiBackendSelectionSchema,
    snapshotTimeoutMs: z.number().int().positive().optional(),
    cacheEnabled: z.boolean().optional()
  }).optional(),
  runtime: z.strictObject({
    backend: RuntimeBackendChoiceSchema
  }).optional(),
  artifactsDir: z.string().trim().min(1).refine(
    (path) => !isInvalidRelativeArtifactDirectory(path),
    "artifactsDir inside .taphound/ must stay under .taphound/build/"
  ).default(DEFAULT_ARTIFACTS_DIR)
});

export type IdlePolicy = z.infer<typeof IdlePolicySchema>;
export type DeviceIdleProfileMatch = z.infer<typeof DeviceIdleProfileMatchSchema>;
export type DeviceIdleProfile = z.infer<typeof DeviceIdleProfileSchema>;
export type TapHoundConfig = z.infer<typeof TapHoundConfigSchema>;

export const DEFAULT_UI_CONFIG = {
  backend: "auto" as const
};

export const DEFAULT_RUNTIME_CONFIG = {
  backend: "auto" as const
};
