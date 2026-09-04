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

export const LayoutPointSchema = z.strictObject({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative()
});

export type LayoutPoint = z.infer<typeof LayoutPointSchema>;

export const LocatorEvidenceSchema = z.strictObject({
  version: z.literal(1),
  semanticSha256: z.string().regex(/^[a-f\d]{64}$/)
});

export type LocatorEvidence = z.infer<typeof LocatorEvidenceSchema>;

export type LocatorMatch = "exact" | "contains" | "startsWith";

export interface Locator {
  resourceId?: string | undefined;
  text?: string | undefined;
  contentDescription?: string | undefined;
  match?: LocatorMatch | undefined;
  index?: number | undefined;
  within?: Locator | undefined;
  evidence?: LocatorEvidence | undefined;
}

export const LocatorMatchSchema = z.enum(["exact", "contains", "startsWith"]);

export const LocatorSchema: z.ZodType<Locator> = z.lazy(
  () => z.strictObject({
    resourceId: z.string().trim().min(1).optional(),
    text: z.string().trim().min(1).optional(),
    contentDescription: z.string().trim().min(1).optional(),
    match: LocatorMatchSchema.optional(),
    index: z.number().int().nonnegative().optional(),
    within: LocatorSchema.optional(),
    evidence: LocatorEvidenceSchema.optional()
  }).refine(
    ({ contentDescription, resourceId, text }) => (
      resourceId !== undefined
      || text !== undefined
      || contentDescription !== undefined
    ),
    { message: "Locator must contain a supported identity field" }
  ).refine(
    ({ evidence, index }) => evidence === undefined || index !== undefined,
    {
      message: "Locator evidence requires index disambiguation",
      path: ["evidence"]
    }
  )
);

export interface LayoutElement {
  id: string;
  windowId?: string | undefined;
  resourceId?: string | undefined;
  text?: string | undefined;
  contentDescription?: string | undefined;
  clickable?: boolean | undefined;
  longClickable?: boolean | undefined;
  scrollable?: boolean | undefined;
  focusable?: boolean | undefined;
  focused?: boolean | undefined;
  enabled: boolean;
  center?: LayoutPoint | undefined;
  bounds?: Bounds | undefined;
  children: LayoutElement[];
}

export const LayoutElementSchema: z.ZodType<LayoutElement> = z.lazy(
  () => z.strictObject({
    id: z.string().min(1),
    windowId: z.string().min(1).optional(),
    resourceId: z.string().min(1).optional(),
    text: z.string().optional(),
    contentDescription: z.string().optional(),
    clickable: z.boolean().optional(),
    longClickable: z.boolean().optional(),
    scrollable: z.boolean().optional(),
    focusable: z.boolean().optional(),
    focused: z.boolean().optional(),
    enabled: z.boolean(),
    center: LayoutPointSchema.optional(),
    bounds: BoundsSchema.optional(),
    children: z.array(LayoutElementSchema).default([])
  })
);
