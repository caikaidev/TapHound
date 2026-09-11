import { z } from "zod";

import { IdlePolicySchema } from "./config.js";

import type { FailureCode } from "./failure.js";

export const TARGETS_SCHEMA_VERSION = 1 as const;

export const DEFAULT_TARGET_ACTIVITY = ".MainActivity";

export const LocalTargetSourceSchema = z.strictObject({
  type: z.literal("local"),
  path: z.string().min(1)
});

export type LocalTargetSource = z.infer<typeof LocalTargetSourceSchema>;

export const ProjectPlatformSchema = z.literal("android");

export const TargetValidationModeSchema = z.literal("local-real");

export const TargetEntrySchema = z.strictObject({
  source: LocalTargetSourceSchema,
  project: z.strictObject({
    platform: ProjectPlatformSchema.default("android")
  }).optional(),
  run: z.strictObject({
    packageName: z.string().regex(
      /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/,
      "packageName must be a qualified Java package"
    ),
    activity: z.string().default(DEFAULT_TARGET_ACTIVITY)
  }),
  build: z.strictObject({
    enabled: z.boolean().default(false),
    command: z.string().optional()
  }).optional(),
  install: z.strictObject({
    enabled: z.boolean().default(false),
    apk: z.string().optional()
  }).optional(),
  git: z.strictObject({
    enabled: z.boolean().default(true)
  }).default({ enabled: true }),
  validation: z.strictObject({
    mode: TargetValidationModeSchema
  }).optional(),
  idle: IdlePolicySchema.optional(),
  artifacts: z.strictObject({
    namespace: z.string().min(1).optional()
  }).optional(),
  override: z.boolean().default(false)
});

export interface TargetEntry extends z.infer<typeof TargetEntrySchema> {
  readonly id?: string;
}

export const TargetsFileSchema = z.strictObject({
  version: z.literal(TARGETS_SCHEMA_VERSION),
  targets: z.record(z.string(), TargetEntrySchema)
});

export type TargetsFile = z.infer<typeof TargetsFileSchema>;

export const DEFAULT_TARGET_IDLE = {
  strategy: "hybrid",
  pollIntervalMs: 200,
  stablePolls: 2,
  timeoutMs: 5000
} as const;

export const AndroidProjectIdentitySchema = z.strictObject({
  rootDir: z.string().min(1),
  settingsFile: z.string().min(1),
  gradleWrapper: z.string().optional(),
  gitRoot: z.string().optional()
});

export type AndroidProjectIdentity = z.infer<typeof AndroidProjectIdentitySchema>;

export const ResolvedTargetSchema = z.strictObject({
  id: z.string().min(1),
  sourceType: z.literal("local"),
  configuredPath: z.string().min(1),
  resolvedPath: z.string().min(1),
  project: AndroidProjectIdentitySchema,
  workspaceRoot: z.string().min(1)
});

export type ResolvedTarget = z.infer<typeof ResolvedTargetSchema>;

export const ProjectFingerprintSchema = z.strictObject({
  schemaVersion: z.literal(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  gitRemote: z.string().optional(),
  rootProjectName: z.string().optional(),
  packageName: z.string().optional()
});

export type ProjectFingerprint = z.infer<typeof ProjectFingerprintSchema>;

export const LocalTargetIdentitySchema = z.strictObject({
  schemaVersion: z.literal(1),
  targetId: z.string().min(1),
  sourceType: z.literal("local"),
  configuredPath: z.string().min(1),
  resolvedPath: z.string().min(1),
  fingerprint: ProjectFingerprintSchema,
  packageName: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type LocalTargetIdentity = z.infer<typeof LocalTargetIdentitySchema>;

export class TargetError extends Error {
  public readonly code: FailureCode;

  public constructor(code: FailureCode, message: string) {
    super(message);
    this.name = "TargetError";
    this.code = code;
  }
}