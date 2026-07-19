import { z } from "zod";

export const BoundsSchema = z.strictObject({
  left: z.number().int().nonnegative(),
  top: z.number().int().nonnegative(),
  right: z.number().int().positive(),
  bottom: z.number().int().positive()
}).refine(
  ({ left, right }) => right > left,
  { message: "right must be greater than left", path: ["right"] }
).refine(
  ({ bottom, top }) => bottom > top,
  { message: "bottom must be greater than top", path: ["bottom"] }
);

export type Bounds = z.infer<typeof BoundsSchema>;

export const LocatorSchema = z.strictObject({
  resourceId: z.string().trim().min(1).optional(),
  text: z.string().min(1).optional(),
  contentDescription: z.string().min(1).optional()
}).refine(
  ({ contentDescription, resourceId, text }) => (
    resourceId !== undefined
    || text !== undefined
    || contentDescription !== undefined
  ),
  { message: "Locator must contain a supported identity field" }
);

export type Locator = z.infer<typeof LocatorSchema>;

export interface LayoutElement {
  id: string;
  resourceId?: string | undefined;
  text?: string | undefined;
  contentDescription?: string | undefined;
  clickable?: boolean | undefined;
  enabled: boolean;
  bounds: Bounds;
  children: LayoutElement[];
}

export const LayoutElementSchema: z.ZodType<LayoutElement> = z.lazy(
  () => z.strictObject({
    id: z.string().min(1),
    resourceId: z.string().min(1).optional(),
    text: z.string().optional(),
    contentDescription: z.string().optional(),
    clickable: z.boolean().optional(),
    enabled: z.boolean(),
    bounds: BoundsSchema,
    children: z.array(LayoutElementSchema).default([])
  })
);
