import { z } from "zod";

export const PointSchema = z.strictObject({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative()
});

export type Point = z.infer<typeof PointSchema>;

export const DisplayViewportSchema = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  rotation: z.union([
    z.literal(0),
    z.literal(90),
    z.literal(180),
    z.literal(270)
  ]),
  coordinateSpace: z.literal("physicalDisplayPixels")
});

export type DisplayViewport = z.infer<typeof DisplayViewportSchema>;
