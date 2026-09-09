import { z } from "zod";

export const RuntimeBackendIdSchema = z.enum([
  "adb",
  "mobile-mcp"
]);
export const RuntimeBackendSelectionSchema = z.enum([
  "auto",
  "adb"
]);
export const RuntimeBackendChoiceSchema = z.enum([
  "auto",
  "adb",
  "mobile-mcp"
]);

export const RuntimeCapabilitiesSchema = z.strictObject({
  layoutSnapshot: z.boolean(),
  screenshot: z.boolean(),
  annotatedScreens: z.boolean(),
  frameStatsIdle: z.boolean(),
  logs: z.boolean(),
  processDiscovery: z.boolean(),
  windowTopology: z.boolean(),
  intentStart: z.boolean(),
  foregroundActivity: z.boolean()
});

export const RuntimeBackendDescriptorSchema = z.strictObject({
  id: RuntimeBackendIdSchema,
  adapterVersion: z.string().min(1),
  engineVersion: z.string().min(1).optional(),
  configSha256: z.string().regex(/^[a-f\d]{64}$/),
  capabilities: RuntimeCapabilitiesSchema
});

export interface DeviceInfo {
  serial: string;
  status: string;
}

export type RuntimeBackendId = z.infer<typeof RuntimeBackendIdSchema>;
export type RuntimeBackendSelection = z.infer<
  typeof RuntimeBackendSelectionSchema
>;
export type RuntimeBackendChoice = z.infer<typeof RuntimeBackendChoiceSchema>;
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;
export type RuntimeBackendDescriptor = z.infer<
  typeof RuntimeBackendDescriptorSchema
>;

const RUNTIME_BACKEND_RESOLUTION: Record<
  RuntimeBackendChoice,
  RuntimeBackendId
> = {
  auto: "adb",
  adb: "adb",
  "mobile-mcp": "mobile-mcp"
};

export function resolveRuntimeBackendId(
  selection: RuntimeBackendChoice
): RuntimeBackendId {
  return RUNTIME_BACKEND_RESOLUTION[selection];
}
