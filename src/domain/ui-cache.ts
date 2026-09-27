import { z } from "zod";

/** In-memory UI snapshot cache telemetry reported by observe and verify. */
export const UiCacheTelemetrySchema = z.strictObject({
  hits: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  relearns: z.number().int().nonnegative(),
  capturesSaved: z.number().int().nonnegative(),
  validationDurationMs: z.number().nonnegative()
});

export type UiCacheTelemetry = z.infer<typeof UiCacheTelemetrySchema>;
