import {
  RoutePlanFailureSchema,
  RoutePlanSchema,
  type GoalSpec,
  type RoutePlan,
  type RoutePlanFailure,
  type RouteSegment
} from "../../domain/route.js";
import type { ScreenDefinition } from "../../domain/knowledge.js";
import { InteractionGraph } from "./interaction-graph.js";

type RoutePlanningResult =
  | { status: "planned"; route: RoutePlan }
  | { status: "failed"; failure: RoutePlanFailure };

interface Candidate {
  screen: string;
  cost: number;
  segments: RouteSegment[];
}

function candidateOrder(left: Candidate, right: Candidate): number {
  return left.cost - right.cost
    || left.segments.map((segment) => segment.transitionId).join("/")
      .localeCompare(
        right.segments.map((segment) => segment.transitionId).join("/")
      );
}

export class RoutePlanner {
  public readonly plan = (input: {
    goal: GoalSpec;
    currentScreen: string;
    knowledgeHash: string;
    screens: readonly ScreenDefinition[];
    graph: InteractionGraph;
    now: Date;
  }): RoutePlanningResult => {
    const screenIds = new Set(input.screens.map((screen) => screen.id));
    if (!screenIds.has(input.currentScreen)) {
      return {
        status: "failed",
        failure: RoutePlanFailureSchema.parse({
          version: 1,
          code: "SCREEN_UNKNOWN",
          message: `Current Screen is not in Knowledge: ${input.currentScreen}`,
          currentScreen: input.currentScreen,
          targetScreen: input.goal.targetScreen
        })
      };
    }
    if (!screenIds.has(input.goal.targetScreen)) {
      return {
        status: "failed",
        failure: RoutePlanFailureSchema.parse({
          version: 1,
          code: "TARGET_UNKNOWN",
          message: `Goal target Screen is not in Knowledge: ${input.goal.targetScreen}`,
          currentScreen: input.currentScreen,
          targetScreen: input.goal.targetScreen
        })
      };
    }

    const pending: Candidate[] = [{
      screen: input.currentScreen,
      cost: 0,
      segments: []
    }];
    const best = new Map<string, number>();
    while (pending.length > 0) {
      pending.sort(candidateOrder);
      const candidate = pending.shift();
      if (candidate === undefined) break;
      if ((best.get(candidate.screen) ?? Number.POSITIVE_INFINITY) < candidate.cost) {
        continue;
      }
      if (candidate.screen === input.goal.targetScreen) {
        return {
          status: "planned",
          route: RoutePlanSchema.parse({
            version: 1,
            goalId: input.goal.id,
            knowledgeHash: input.knowledgeHash,
            startScreen: input.currentScreen,
            targetScreen: input.goal.targetScreen,
            segments: candidate.segments,
            totalCost: candidate.cost,
            plannedAt: input.now.toISOString()
          })
        };
      }
      if (candidate.segments.length >= input.goal.limits.maxSteps) continue;
      for (const edge of input.graph.edgesFrom(candidate.screen)) {
        const cost = candidate.cost + edge.cost;
        const known = best.get(edge.transition.toScreen);
        if (known !== undefined && known <= cost) continue;
        best.set(edge.transition.toScreen, cost);
        pending.push({
          screen: edge.transition.toScreen,
          cost,
          segments: [
            ...candidate.segments,
            {
              index: candidate.segments.length,
              transitionId: edge.transition.id,
              fromScreen: edge.transition.fromScreen,
              toScreen: edge.transition.toScreen,
              cost: edge.cost
            }
          ]
        });
      }
    }
    return {
      status: "failed",
      failure: RoutePlanFailureSchema.parse({
        version: 1,
        code: "NO_ROUTE",
        message: `No known allowed Route reaches ${input.goal.targetScreen}`,
        currentScreen: input.currentScreen,
        targetScreen: input.goal.targetScreen
      })
    };
  };
}
