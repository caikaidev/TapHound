import { describe, expect, it } from "vitest";

import { InteractionGraph } from "../../../src/application/planning/interaction-graph.js";
import { RoutePlanner } from "../../../src/application/planning/route-planner.js";
import type {
  ScreenDefinition,
  TransitionDefinition
} from "../../../src/domain/knowledge.js";

function screen(id: string): ScreenDefinition {
  return {
    version: 1,
    id,
    status: "verified",
    requiredAnchors: ["app"],
    optionalAnchors: [],
    forbiddenAnchors: [],
    predicates: []
  };
}

function transition(
  id: string,
  fromScreen: string,
  toScreen: string,
  status: TransitionDefinition["status"]
): TransitionDefinition {
  return {
    version: 1,
    id,
    status,
    fromScreen,
    toScreen,
    semantic: id,
    action: { action: "wait" },
    verification: { targetScreen: toScreen, timeoutMs: 1000 },
    observations: { attempts: 0, successes: 0, recoveryCost: 0 }
  };
}

describe("RoutePlanner", () => {
  it("prefers a lower-cost verified Route over a direct inferred edge", () => {
    const transitions = [
      transition("direct", "home", "target", "inferred"),
      transition("to-middle", "home", "middle", "verified"),
      transition("to-target", "middle", "target", "verified")
    ];
    const result = new RoutePlanner().plan({
      goal: {
        version: 1,
        id: "reach-target",
        targetScreen: "target",
        parameters: {},
        limits: { maxSteps: 5, maxReplans: 2 }
      },
      currentScreen: "home",
      knowledgeHash: "a".repeat(64),
      screens: [screen("home"), screen("middle"), screen("target")],
      graph: new InteractionGraph(transitions),
      now: new Date("2026-09-06T00:00:00.000Z")
    });

    expect(result).toMatchObject({
      status: "planned",
      route: {
        segments: [
          { transitionId: "to-middle" },
          { transitionId: "to-target" }
        ]
      }
    });
  });

  it("returns NO_ROUTE instead of inventing an action", () => {
    expect(new RoutePlanner().plan({
      goal: {
        version: 1,
        id: "reach-target",
        targetScreen: "target",
        parameters: {},
        limits: { maxSteps: 5, maxReplans: 2 }
      },
      currentScreen: "home",
      knowledgeHash: "a".repeat(64),
      screens: [screen("home"), screen("target")],
      graph: new InteractionGraph([]),
      now: new Date("2026-09-06T00:00:00.000Z")
    })).toMatchObject({ status: "failed", failure: { code: "NO_ROUTE" } });
  });
});
