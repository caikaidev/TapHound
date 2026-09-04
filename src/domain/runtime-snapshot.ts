import { createHash } from "node:crypto";

import { z } from "zod";

import { LayoutElementSchema } from "./layout.js";
import { DisplayViewportSchema } from "./geometry.js";
import { UiBackendDescriptorSchema } from "./ui-backend.js";
import { WindowHierarchySchema } from "./window-hierarchy.js";

const QualifiedNameSchema = z.string().regex(
  /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/,
  "Value must be fully qualified"
);

const RuntimeSnapshotFields = {
  generationId: z.string().trim().min(1),
  baseRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  deviceSerial: z.string().trim().min(1),
  expectedPackageName: QualifiedNameSchema,
  foregroundPackageName: QualifiedNameSchema,
  activity: QualifiedNameSchema,
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  capturedAt: z.iso.datetime(),
  screenshotPath: z.string().trim().min(1).optional(),
  layout: z.array(LayoutElementSchema),
  windowHierarchy: WindowHierarchySchema.optional()
};

export const RuntimeSnapshotV1Schema = z.strictObject({
  version: z.literal(1),
  ...RuntimeSnapshotFields
});

export const RuntimeSnapshotV2Schema = z.strictObject({
  version: z.literal(2),
  ...RuntimeSnapshotFields,
  uiBackend: UiBackendDescriptorSchema,
  uiObservationId: z.string().trim().min(1),
  uiCaptureDurationMs: z.number().nonnegative(),
  viewport: DisplayViewportSchema
});

export const RuntimeSnapshotSchema = z.discriminatedUnion("version", [
  RuntimeSnapshotV1Schema,
  RuntimeSnapshotV2Schema
]);

export type RuntimeSnapshotV1 = z.infer<typeof RuntimeSnapshotV1Schema>;
export type RuntimeSnapshotV2 = z.infer<typeof RuntimeSnapshotV2Schema>;
export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function hashRuntimeSnapshot(snapshot: unknown): string {
  const parsed = RuntimeSnapshotSchema.parse(snapshot);
  const content = {
    version: parsed.version,
    generationId: parsed.generationId,
    baseRevision: parsed.baseRevision,
    deviceSerial: parsed.deviceSerial,
    expectedPackageName: parsed.expectedPackageName,
    foregroundPackageName: parsed.foregroundPackageName,
    activity: parsed.activity,
    pid: parsed.pid,
    layout: parsed.layout,
    windowHierarchy: parsed.windowHierarchy,
    ...(parsed.version === 1
      ? {}
      : {
          uiBackend: parsed.uiBackend,
          viewport: parsed.viewport
        })
  };

  return createHash("sha256")
    .update(JSON.stringify(canonicalize(content)))
    .digest("hex");
}
