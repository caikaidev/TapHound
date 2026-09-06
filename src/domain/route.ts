import { createHash } from "node:crypto";

import { z } from "zod";

import {
  KnowledgeIdSchema,
  KnowledgeSha256Schema
} from "./knowledge.js";
import { ProposalBindingSchema, ProposedStepSchema } from "./proposed-step.js";

const GoalParameterSchema = z.string().refine(
  (value) => !value.includes("${"),
  "Goal parameters must be literal values"
);

export const GoalSpecSchema = z.strictObject({
  version: z.literal(1),
  id: KnowledgeIdSchema,
  targetScreen: KnowledgeIdSchema,
  parameters: z.record(KnowledgeIdSchema, GoalParameterSchema).default({}),
  limits: z.strictObject({
    maxSteps: z.number().int().positive().max(100),
    maxReplans: z.number().int().nonnegative().max(20)
  })
});

export const RouteSegmentSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  transitionId: KnowledgeIdSchema,
  fromScreen: KnowledgeIdSchema,
  toScreen: KnowledgeIdSchema,
  cost: z.number().nonnegative()
});

export const RoutePlanSchema = z.strictObject({
  version: z.literal(1),
  goalId: KnowledgeIdSchema,
  knowledgeHash: KnowledgeSha256Schema,
  startScreen: KnowledgeIdSchema,
  targetScreen: KnowledgeIdSchema,
  segments: z.array(RouteSegmentSchema),
  totalCost: z.number().nonnegative(),
  plannedAt: z.iso.datetime()
}).superRefine((route, context) => {
  if (route.segments.length === 0 && route.startScreen !== route.targetScreen) {
    context.addIssue({
      code: "custom",
      path: ["segments"],
      message: "A non-trivial Route needs at least one segment"
    });
  }
  let expected = route.startScreen;
  let totalCost = 0;
  for (const [index, segment] of route.segments.entries()) {
    if (
      segment.index !== index
      || segment.fromScreen !== expected
    ) {
      context.addIssue({
        code: "custom",
        path: ["segments", index],
        message: "Route segments must be contiguous and correctly indexed"
      });
    }
    expected = segment.toScreen;
    totalCost += segment.cost;
  }
  if (expected !== route.targetScreen) {
    context.addIssue({
      code: "custom",
      path: ["targetScreen"],
      message: "Route must end at targetScreen"
    });
  }
  if (Math.abs(totalCost - route.totalCost) > Number.EPSILON * 100) {
    context.addIssue({
      code: "custom",
      path: ["totalCost"],
      message: "Route totalCost must equal the segment cost sum"
    });
  }
});

export const RoutePlanFailureSchema = z.strictObject({
  version: z.literal(1),
  code: z.enum([
    "SCREEN_UNKNOWN",
    "SCREEN_AMBIGUOUS",
    "TARGET_UNKNOWN",
    "NO_ROUTE",
    "ROUTE_LIMIT_EXCEEDED",
    "ANCHOR_UNKNOWN",
    "ANCHOR_AMBIGUOUS",
    "PARAMETER_MISSING",
    "KNOWLEDGE_STALE"
  ]),
  message: z.string().trim().min(1),
  currentScreen: KnowledgeIdSchema.optional(),
  targetScreen: KnowledgeIdSchema.optional()
});

export const JourneyContextSchema = z.strictObject({
  version: z.literal(1),
  goal: GoalSpecSchema,
  knowledgeHash: KnowledgeSha256Schema,
  currentScreen: KnowledgeIdSchema,
  route: RoutePlanSchema,
  relevantScreens: z.array(KnowledgeIdSchema),
  relevantAnchors: z.array(KnowledgeIdSchema),
  relevantTransitions: z.array(KnowledgeIdSchema)
});

export const ResolvedRouteActionSchema = z.strictObject({
  version: z.literal(1),
  transitionId: KnowledgeIdSchema,
  binding: ProposalBindingSchema,
  proposal: ProposedStepSchema
});

export type GoalSpec = z.infer<typeof GoalSpecSchema>;
export type RoutePlan = z.infer<typeof RoutePlanSchema>;
export type RouteSegment = z.infer<typeof RouteSegmentSchema>;
export type RoutePlanFailure = z.infer<typeof RoutePlanFailureSchema>;
export type JourneyContext = z.infer<typeof JourneyContextSchema>;
export type ResolvedRouteAction = z.infer<typeof ResolvedRouteActionSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function hashGoalSpec(value: unknown): string {
  const goal = GoalSpecSchema.parse(value);
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(goal)))
    .digest("hex");
}
