import { z } from "zod";

import { LayoutElementSchema } from "./layout.js";

export const ObserveReportSchema = z.strictObject({
  deviceSerial: z.string().min(1),
  packageName: z.string().min(1),
  activity: z.string().min(1).optional(),
  foreground: z.strictObject({
    packageName: z.string().min(1),
    activity: z.string().min(1)
  }),
  layout: z.array(LayoutElementSchema),
  logcat: z.array(z.string()).optional()
});

export type ObserveReport = z.infer<typeof ObserveReportSchema>;
