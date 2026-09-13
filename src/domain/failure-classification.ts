import { z } from "zod";

import { FAILURE_CODES } from "./failure.js";
import { LocatorSchema } from "./layout.js";

/**
 * Failure taxonomy: the deterministic classification of a failed run.
 *
 * The taxonomy is driven by the failure code + report facts, never by a
 * model. A Coding Agent consumes the structured classification, not raw logs
 * (architecture doc §20).
 */
export const FailureTypeSchema = z.enum([
  "target_not_found",
  "target_ambiguous",
  "target_unresolved",
  "activity_mismatch",
  "app_crash",
  "launch",
  "environment_missing",
  "capability_missing",
  "timeout",
  "interaction",
  "action_failed",
  "expect_failed",
  "contract_invalid",
  "evidence_failed",
  "alignment_failed",
  "collection_failed",
  "internal_error"
]);

export const FailureStageSchema = z.enum([
  "setup",
  "launch",
  "navigation",
  "interaction",
  "assertion",
  "evidence",
  "finalize",
  "unknown"
]);

export const FailureClassificationSchema = z.strictObject({
  version: z.literal(1),
  runId: z.string().trim().min(1),
  classificationId: z.string().trim().min(1),
  type: FailureTypeSchema,
  stage: FailureStageSchema,
  code: z.enum(FAILURE_CODES),
  message: z.string().trim().min(1),
  stepIndex: z.number().int().nonnegative().optional(),
  expected: z.string().trim().min(1).optional(),
  actual: z.string().trim().min(1).optional(),
  locator: LocatorSchema.optional(),
  evidenceRefs: z.array(z.string().trim().min(1)).default([]),
  sourceReportPath: z.string().trim().min(1)
});

export type FailureType = z.infer<typeof FailureTypeSchema>;
export type FailureStage = z.infer<typeof FailureStageSchema>;
export type FailureClassification = z.infer<
  typeof FailureClassificationSchema
>;

/** Canonical map from failure code to taxonomy type (deterministic). */
export const FAILURE_CODE_TYPES: Readonly<Record<string, FailureType>> = {
  CONFIG_INVALID: "internal_error",
  ENVIRONMENT_MISSING_TOOL: "environment_missing",
  DEVICE_UNAVAILABLE: "environment_missing",
  UI_BACKEND_UNAVAILABLE: "environment_missing",
  RUNTIME_CAPABILITY_MISSING: "capability_missing",
  UI_SNAPSHOT_FAILED: "environment_missing",
  UI_SNAPSHOT_INVALID: "environment_missing",
  APP_NOT_INSTALLED: "environment_missing",
  APP_LAUNCH_FAILED: "launch",
  APP_CRASHED: "app_crash",
  LOCATOR_NOT_FOUND: "target_not_found",
  LOCATOR_AMBIGUOUS: "target_ambiguous",
  ANCHOR_NOT_FOUND: "target_unresolved",
  ANCHOR_AMBIGUOUS: "target_ambiguous",
  SCROLL_TARGET_NOT_FOUND: "target_not_found",
  ACTION_FAILED: "interaction",
  IDLE_TIMEOUT: "timeout",
  ACTIVITY_BEFORE_MISMATCH: "activity_mismatch",
  ACTIVITY_AFTER_MISMATCH: "activity_mismatch",
  EXPECT_ACTIVITY_FAILED: "expect_failed",
  EXPECT_ELEMENT_FAILED: "expect_failed",
  EXPECT_LOGCAT_FAILED: "expect_failed",
  BRIDGE_NO_ESCAPE: "interaction",
  BRIDGE_NOT_RETURNED: "timeout",
  WAIT_TIMEOUT: "timeout",
  DEVICE_ROLE_UNMAPPED: "environment_missing",
  EXTERNAL_FLOW_NOT_FOUND: "target_not_found",
  EXTERNAL_FLOW_STALE: "contract_invalid",
  EXTERNAL_LOCATOR_STRICTNESS: "target_unresolved",
  EXTERNAL_PACKAGE_MISMATCH: "activity_mismatch",
  EXTERNAL_ACTIVITY_MISMATCH: "activity_mismatch",
  EXTERNAL_STEP_FAILED: "interaction",
  CONTEXT_INVALID: "internal_error",
  CONTEXT_STALE: "contract_invalid",
  CONTEXT_MODULE_NOT_FOUND: "internal_error",
  CONTEXT_MODULE_INCOMPLETE: "internal_error",
  CONTEXT_SCHEMA_INVALID: "internal_error",
  CONTEXT_IDENTITY_MISMATCH: "contract_invalid",
  PROJECT_ROOT_UNREADABLE: "environment_missing",
  PROJECT_ROOT_NOT_DIRECTORY: "environment_missing",
  EVIDENCE_SECRET_PATH: "evidence_failed",
  EVIDENCE_NOT_FOUND: "evidence_failed",
  EVIDENCE_UNREADABLE: "evidence_failed",
  EVIDENCE_NOT_FILE: "evidence_failed",
  EVIDENCE_PATH_ESCAPE: "evidence_failed",
  EVIDENCE_CHANGED_IDENTITY: "evidence_failed",
  EVIDENCE_TOO_LARGE: "evidence_failed",
  EVIDENCE_HASH_MISMATCH: "evidence_failed",
  MANUAL_STEP_REQUIRED: "timeout",
  ALIGN_DEVICE_UNAVAILABLE: "alignment_failed",
  ALIGN_CAMERA_INTENT_FAILED: "alignment_failed",
  ALIGN_CAMERA_NOT_LAUNCHED: "alignment_failed",
  ALIGN_SHUTTER_NOT_FOUND: "alignment_failed",
  ALIGN_SHUTTER_AMBIGUOUS: "alignment_failed",
  ALIGN_SHUTTER_NO_RESOURCE_ID: "alignment_failed",
  ALIGN_CONFIRM_NOT_FOUND: "alignment_failed",
  ALIGN_CONFIRM_AMBIGUOUS: "alignment_failed",
  ALIGN_CONFIRM_NO_RESOURCE_ID: "alignment_failed",
  ALIGN_FLOW_EXISTS: "alignment_failed",
  LOCAL_TARGET_NOT_FOUND: "environment_missing",
  LOCAL_TARGET_ENV_MISSING: "environment_missing",
  LOCAL_TARGET_PATH_INVALID: "environment_missing",
  LOCAL_TARGET_NOT_DIRECTORY: "environment_missing",
  LOCAL_TARGET_NOT_ANDROID_PROJECT: "environment_missing",
  LOCAL_TARGET_SYMLINK_BROKEN: "environment_missing",
  LOCAL_TARGET_PROJECT_CHANGED: "contract_invalid",
  TARGET_ID_CONFLICT: "internal_error",
  TARGET_CONFIG_INVALID: "internal_error",
  PACKAGE_IDENTITY_MISMATCH: "contract_invalid",
  GIT_ROOT_NOT_FOUND: "environment_missing",
  GIT_REF_INVALID: "environment_missing",
  CONTRACT_INVALID: "contract_invalid",
  CONTRACT_JOURNEY_MISSING: "contract_invalid",
  CONTRACT_JOURNEY_DRIFT: "contract_invalid",
  CONTRACT_EVIDENCE_INSUFFICIENT: "evidence_failed",
  CONTRACT_KNOWLEDGE_UNAVAILABLE: "capability_missing",
  COLLECTION_FAILED: "collection_failed",
  INTERNAL_ERROR: "internal_error"
} as const;

/** Canonical map from failure type to likely stage (deterministic). */
export const FAILURE_TYPE_STAGES: Readonly<Record<FailureType, FailureStage>> = {
  target_not_found: "interaction",
  target_ambiguous: "interaction",
  target_unresolved: "interaction",
  activity_mismatch: "navigation",
  app_crash: "launch",
  launch: "launch",
  environment_missing: "setup",
  capability_missing: "setup",
  timeout: "interaction",
  interaction: "interaction",
  action_failed: "interaction",
  expect_failed: "assertion",
  contract_invalid: "setup",
  evidence_failed: "evidence",
  alignment_failed: "setup",
  collection_failed: "evidence",
  internal_error: "unknown"
} as const;

/** Families that carry step-level detail (stepIndex / locator). */
export const STEP_INDEXED_FAILURE_TYPES: ReadonlySet<FailureType> = new Set([
  "target_not_found",
  "target_ambiguous",
  "target_unresolved",
  "activity_mismatch",
  "app_crash",
  "timeout",
  "expect_failed"
]);