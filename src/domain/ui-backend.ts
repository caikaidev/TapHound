import { z } from "zod";

export const UiBackendIdSchema = z.enum([
  "system-uiautomator",
  "android-cli",
  "appium-uiautomator2",
  "mobile-mcp"
]);

// Selection stays narrower than descriptor ids: "mobile-mcp" layouts arrive
// only through the Runtime Backend SPI (runtime.backend), never as a direct
// ui.backend choice, so AutoUiSnapshotProviderFactory never sees it.
export const UiBackendSelectionSchema = z.enum([
  "auto",
  "system-uiautomator",
  "android-cli",
  "appium-uiautomator2"
]);

export const UiBackendDescriptorSchema = z.strictObject({
  id: UiBackendIdSchema,
  adapterVersion: z.string().min(1),
  engineVersion: z.string().min(1).optional(),
  configSha256: z.string().regex(/^[a-f\d]{64}$/)
});

export type UiBackendDescriptor = z.infer<
  typeof UiBackendDescriptorSchema
>;
export type UiBackendId = z.infer<typeof UiBackendIdSchema>;
export type UiBackendSelection = z.infer<typeof UiBackendSelectionSchema>;

// Descriptor ids can name runtime-bound backends ("mobile-mcp") that never
// participate in direct ui.backend selection; opening those through the
// legacy snapshot factories must fail closed instead of silently re-routing.
export function uiBackendIdAsSelection(id: UiBackendId): UiBackendSelection {
  if (id === "system-uiautomator" || id === "android-cli"
    || id === "appium-uiautomator2") {
    return id;
  }
  throw new Error(
    `UI backend "${id}" cannot be opened through the direct snapshot factory`
  );
}
