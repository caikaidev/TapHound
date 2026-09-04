import { z } from "zod";

export const UiBackendIdSchema = z.enum([
  "system-uiautomator",
  "android-cli",
  "appium-uiautomator2"
]);

export const UiBackendSelectionSchema = z.enum([
  "auto",
  ...UiBackendIdSchema.options
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
export type UiBackendSelection = z.infer<typeof UiBackendSelectionSchema>;
