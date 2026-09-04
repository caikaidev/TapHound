import { z } from "zod";

import {
  DEFAULT_ARTIFACTS_DIR,
  isInvalidRelativeArtifactDirectory
} from "./workspace.js";
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

export const TapHoundConfigSchema = z.strictObject({
  version: z.literal(1),
  run: z.strictObject({
    packageName: PackageNameSchema,
    activity: ActivityNameSchema
  }),
  idle: z.strictObject({
    strategy: z.enum(["hybrid", "layoutDiff", "frameStats", "structural"]).default("hybrid"),
    pollIntervalMs: z.number().int().positive(),
    stablePolls: z.number().int().positive(),
    timeoutMs: z.number().int().positive()
  }),
  ui: z.strictObject({
    backend: UiBackendSelectionSchema,
    snapshotTimeoutMs: z.number().int().positive().optional(),
    cacheEnabled: z.boolean().optional()
  }).optional(),
  artifactsDir: z.string().trim().min(1).refine(
    (path) => !isInvalidRelativeArtifactDirectory(path),
    "artifactsDir inside .taphound/ must stay under .taphound/build/"
  ).default(DEFAULT_ARTIFACTS_DIR)
});

export type TapHoundConfig = z.infer<typeof TapHoundConfigSchema>;

export const DEFAULT_UI_CONFIG = {
  backend: "auto" as const
};
