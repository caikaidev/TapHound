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

export type LocatorMatch = "exact" | "contains" | "startsWith" | "regex";
export type LocatorCombine = "priority" | "all";
export interface LocatorMatchBy {
  resourceId?: LocatorMatch | undefined;
  text?: LocatorMatch | undefined;
  contentDescription?: LocatorMatch | undefined;
}

export interface Locator {
  resourceId?: string | undefined;
  text?: string | undefined;
  contentDescription?: string | undefined;
  match?: LocatorMatch | undefined;
  matchBy?: LocatorMatchBy | undefined;
  combine?: LocatorCombine | undefined;
  index?: number | undefined;
  within?: Locator | undefined;
  evidence?: LocatorEvidence | undefined;
}

export const LocatorMatchSchema = z.enum([
  "exact",
  "contains",
  "startsWith",
  "regex"
]);

export const LocatorCombineSchema = z.enum(["priority", "all"]);

const LocatorPatternSchema = z.string().trim().min(1).max(512);

function validateRegex(
  pattern: string,
  context: z.RefinementCtx,
  path: PropertyKey[]
): void {
  try {
    new RegExp(pattern);
  } catch {
    context.addIssue({
      code: "custom",
      path,
      message: "Locator regex must be a valid regular expression"
    });
  }
}

export const LocatorSchema: z.ZodType<Locator> = z.lazy(
  () => z.strictObject({
    resourceId: LocatorPatternSchema.optional(),
    text: LocatorPatternSchema.optional(),
    contentDescription: LocatorPatternSchema.optional(),
    match: LocatorMatchSchema.optional(),
    matchBy: z.strictObject({
      resourceId: LocatorMatchSchema.optional(),
      text: LocatorMatchSchema.optional(),
      contentDescription: LocatorMatchSchema.optional()
    }).optional(),
    combine: LocatorCombineSchema.optional(),
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
  ).superRefine((locator, context) => {
    const fields = [
      "resourceId",
      "text",
      "contentDescription"
    ] as const;
    for (const field of fields) {
      const value = locator[field];
      const fieldMatch = locator.matchBy?.[field] ?? locator.match;
      if (locator.matchBy?.[field] !== undefined && value === undefined) {
        context.addIssue({
          code: "custom",
          path: ["matchBy", field],
          message: `Locator matchBy.${field} requires ${field}`
        });
      }
      if (value !== undefined && fieldMatch === "regex") {
        validateRegex(value, context, [field]);
      }
    }
  })
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
