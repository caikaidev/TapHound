import type {
  AnchorDefinition,
  ScreenDefinition,
  TransitionDefinition
} from "../../domain/knowledge.js";
import {
  ResolvedRouteActionSchema,
  RoutePlanFailureSchema,
  type GoalSpec,
  type ResolvedRouteAction,
  type RoutePlanFailure
} from "../../domain/route.js";
import type { ProposalBinding } from "../../domain/proposed-step.js";

export type ActionResolutionResult =
  | { status: "resolved"; action: ResolvedRouteAction }
  | { status: "failed"; failure: RoutePlanFailure };

function failure(
  code: "ANCHOR_UNKNOWN" | "ANCHOR_AMBIGUOUS" | "PARAMETER_MISSING",
  message: string
): ActionResolutionResult {
  return {
    status: "failed",
    failure: RoutePlanFailureSchema.parse({ version: 1, code, message })
  };
}

export class ActionResolver {
  public readonly resolve = (input: {
    transition: TransitionDefinition;
    anchors: readonly AnchorDefinition[];
    screens: readonly ScreenDefinition[];
    goal: GoalSpec;
    binding: ProposalBinding;
    activity: string;
  }): ActionResolutionResult => {
    const anchorById = new Map(input.anchors.map((anchor) => [anchor.id, anchor]));
    const locator = (anchorId: string): AnchorDefinition["identity"] | undefined => (
      anchorById.get(anchorId)?.identity
    );
    const target = input.screens.find(
      (screen) => screen.id === input.transition.toScreen
    );
    const activityPredicate = target?.predicates.find(
      (predicate) => predicate.kind === "activityIs"
    );
    const expect = activityPredicate?.kind === "activityIs"
      ? {
          type: "activity" as const,
          value: activityPredicate.activity,
          timeoutMs: input.transition.verification.timeoutMs
        }
      : undefined;
    const common = {
      binding: input.binding,
      activity: { before: input.activity },
      ...(expect === undefined ? {} : { expect })
    };
    const action = input.transition.action;
    let proposal: unknown;
    switch (action.action) {
      case "click":
      case "longClick":
      case "swipe": {
        const identity = locator(action.anchorId);
        if (identity === undefined) {
          return failure("ANCHOR_UNKNOWN", `Unknown Anchor ${action.anchorId}`);
        }
        if (identity.kind !== "element") {
          return failure(
            "ANCHOR_AMBIGUOUS",
            `Anchor ${action.anchorId} is not an actionable element`
          );
        }
        proposal = { ...action, locator: identity.locator, ...common };
        delete (proposal as { anchorId?: unknown }).anchorId;
        break;
      }
      case "scrollTo": {
        const identity = locator(action.anchorId);
        const container = locator(action.containerAnchorId);
        if (identity === undefined || container === undefined) {
          return failure(
            "ANCHOR_UNKNOWN",
            "scrollTo references an unknown target or container Anchor"
          );
        }
        if (identity.kind !== "element" || container.kind !== "element") {
          return failure(
            "ANCHOR_AMBIGUOUS",
            "scrollTo target and container Anchors must be elements"
          );
        }
        proposal = {
          action: "scrollTo",
          locator: identity.locator,
          container: container.locator,
          direction: action.direction,
          maxSwipes: action.maxSwipes,
          distancePercent: action.distancePercent,
          durationMs: action.durationMs,
          ...common
        };
        break;
      }
      case "inputText": {
        const text = input.goal.parameters[action.parameter];
        if (text === undefined) {
          return failure(
            "PARAMETER_MISSING",
            `Goal parameter is missing: ${action.parameter}`
          );
        }
        proposal = { action: "inputText", text, ...common };
        break;
      }
      case "back":
      case "wait":
        proposal = { action: action.action, ...common };
        break;
    }
    return {
      status: "resolved",
      action: ResolvedRouteActionSchema.parse({
        version: 1,
        transitionId: input.transition.id,
        binding: input.binding,
        proposal
      })
    };
  };
}
