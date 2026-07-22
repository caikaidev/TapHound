import { createHash } from "node:crypto";

import { z } from "zod";

import { LayoutElementSchema } from "./layout.js";

const QualifiedNameSchema = z.string().regex(
  /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/,
  "Value must be fully qualified"
);

export const RuntimeSnapshotSchema = z.strictObject({
  version: z.literal(1),
  packageName: QualifiedNameSchema,
  activity: QualifiedNameSchema,
  capturedAt: z.iso.datetime(),
  screenshotPath: z.string().trim().min(1).optional(),
  layout: z.array(LayoutElementSchema)
});

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
    packageName: parsed.packageName,
    activity: parsed.activity,
    layout: parsed.layout
  };

  return createHash("sha256")
    .update(JSON.stringify(canonicalize(content)))
    .digest("hex");
}
