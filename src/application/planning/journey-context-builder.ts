import {
  JourneyContextSchema,
  type GoalSpec,
  type JourneyContext,
  type RoutePlan
} from "../../domain/route.js";
import type { LoadedKnowledgeBundle } from "../../ports/knowledge-registry.js";

export class JourneyContextBuilder {
  public readonly build = (input: {
    goal: GoalSpec;
    currentScreen: string;
    route: RoutePlan;
    knowledge: LoadedKnowledgeBundle;
  }): JourneyContext => {
    const transitions = new Map(
      input.knowledge.transitions.map((transition) => [transition.id, transition])
    );
    const routeTransitions = input.route.segments.map((segment) => {
      const transition = transitions.get(segment.transitionId);
      if (transition === undefined) {
        throw new Error(`Route references unknown Transition ${segment.transitionId}`);
      }
      return transition;
    });
    const anchorIds = new Set<string>();
    for (const transition of routeTransitions) {
      if ("anchorId" in transition.action) {
        anchorIds.add(transition.action.anchorId);
      }
      if ("containerAnchorId" in transition.action) {
        anchorIds.add(transition.action.containerAnchorId);
      }
    }
    return JourneyContextSchema.parse({
      version: 1,
      goal: input.goal,
      knowledgeHash: input.knowledge.knowledgeHash,
      currentScreen: input.currentScreen,
      route: input.route,
      relevantScreens: [
        input.currentScreen,
        ...input.route.segments.map((segment) => segment.toScreen)
      ].filter((value, index, values) => values.indexOf(value) === index),
      relevantAnchors: [...anchorIds].sort((left, right) => left.localeCompare(right)),
      relevantTransitions: input.route.segments.map(
        (segment) => segment.transitionId
      )
    });
  };
}
