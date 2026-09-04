import { createHash } from "node:crypto";

import { z } from "zod";

import { JourneyStepSchema } from "./journey.js";
import { LocatorSchema, type Locator } from "./layout.js";
import { UiBackendDescriptorSchema } from "./ui-backend.js";

const Sha256Schema = z.string().regex(/^[a-f\d]{64}$/);
const CacheIdentifierSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/,
  "Cache identifiers must be stable, non-sensitive names"
);

export const AppBuildIdentitySchema = z.strictObject({
  packageName: z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/),
  versionCode: z.number().int().nonnegative(),
  lastUpdateTime: z.iso.datetime(),
  buildSha256: Sha256Schema,
  signingCertificateSha256: Sha256Schema
});

export const UiEnvironmentIdentitySchema = z.strictObject({
  apiLevel: z.number().int().min(26),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  densityDpi: z.number().int().positive(),
  fontScale: z.number().positive(),
  rotation: z.union([
    z.literal(0),
    z.literal(90),
    z.literal(180),
    z.literal(270)
  ]),
  locale: z.string().trim().min(1),
  nightMode: z.boolean()
});

function locatorIsPersistenceSafe(locator: Locator): boolean {
  return locator.resourceId !== undefined
    && locator.text === undefined
    && locator.contentDescription === undefined
    && (locator.within === undefined || locatorIsPersistenceSafe(locator.within));
}

export const PersistentLocatorSchema = LocatorSchema.refine(
  locatorIsPersistenceSafe,
  "Persistent UI cache locators must be resourceId-based and contain no page text"
);

export const ScreenContractSchema = z.strictObject({
  requiredAnchors: z.array(PersistentLocatorSchema).min(1).max(3),
  forbiddenAnchors: z.array(PersistentLocatorSchema).max(3).optional(),
  semanticFingerprintVersion: z.literal(1),
  semanticFingerprint: Sha256Schema
});

export const CachedScreenTargetSchema = z.strictObject({
  purpose: CacheIdentifierSchema,
  locator: PersistentLocatorSchema,
  requiredCapability: z.enum([
    "clickable",
    "longClickable",
    "scrollable"
  ]).optional()
});

export const CachedScreenModelSchema = z.strictObject({
  schemaVersion: z.literal(1),
  screenId: CacheIdentifierSchema,
  appBuild: AppBuildIdentitySchema,
  environment: UiEnvironmentIdentitySchema,
  backend: UiBackendDescriptorSchema,
  activity: z.string().regex(/^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/),
  contract: ScreenContractSchema,
  targets: z.array(CachedScreenTargetSchema).min(1),
  verifiedAt: z.iso.datetime()
});

function hasForbiddenPersistentField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenPersistentField);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => (
    [
      "bounds",
      "center",
      "contentDescription",
      "elementId",
      "pageSource",
      "screenshot",
      "text"
    ].includes(key) || hasForbiddenPersistentField(item)
  ));
}

function isPersistentFlowStepSafe(
  step: z.infer<typeof JourneyStepSchema>
): boolean {
  if (step.action === "bridge" || step.action === "inputText") return false;
  if (step.expect?.type === "logcat") return false;
  return !hasForbiddenPersistentField(step);
}

const PersistentJourneyStepSchema = JourneyStepSchema.refine(
  isPersistentFlowStepSafe,
  "Persistent Flow fragments cannot contain coordinates, handles, screenshots, or text payloads"
);

export const FlowVerificationReceiptSchema = z.strictObject({
  appBuild: AppBuildIdentitySchema,
  environmentSha256: Sha256Schema,
  uiBackend: UiBackendDescriptorSchema,
  reportSha256: Sha256Schema,
  verifiedAt: z.iso.datetime()
});

export const CachedFlowFragmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: CacheIdentifierSchema,
  start: ScreenContractSchema,
  end: ScreenContractSchema,
  steps: z.array(PersistentJourneyStepSchema).min(1),
  sourceSha256: Sha256Schema,
  verifiedBuilds: z.array(FlowVerificationReceiptSchema)
});

export const UiCacheTelemetrySchema = z.strictObject({
  hits: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  relearns: z.number().int().nonnegative(),
  capturesSaved: z.number().int().nonnegative(),
  validationDurationMs: z.number().nonnegative()
});

export type AppBuildIdentity = z.infer<typeof AppBuildIdentitySchema>;
export type UiEnvironmentIdentity = z.infer<typeof UiEnvironmentIdentitySchema>;
export type ScreenContract = z.infer<typeof ScreenContractSchema>;
export type CachedScreenModel = z.infer<typeof CachedScreenModelSchema>;
export type CachedScreenTarget = z.infer<typeof CachedScreenTargetSchema>;
export type FlowVerificationReceipt = z.infer<
  typeof FlowVerificationReceiptSchema
>;
export type CachedFlowFragment = z.infer<typeof CachedFlowFragmentSchema>;
export type UiCacheTelemetry = z.infer<typeof UiCacheTelemetrySchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function hashCanonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function screenModelCacheKey(model: CachedScreenModel): string {
  return hashCanonical({
    schemaVersion: model.schemaVersion,
    screenId: model.screenId,
    appBuild: model.appBuild,
    environment: model.environment,
    backend: model.backend,
    activity: model.activity
  });
}

export function flowFragmentCacheKey(name: string): string {
  return hashCanonical({ schemaVersion: 1, name });
}
