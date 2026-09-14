import { z } from "zod";

export const JourneyLifecycleStateSchema = z.enum([
  "draft",
  "verified",
  "promoted",
  "suspect",
  "stale",
  "retired"
]);

export type JourneyLifecycleState = z.infer<typeof JourneyLifecycleStateSchema>;