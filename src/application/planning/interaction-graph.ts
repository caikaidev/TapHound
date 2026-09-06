import type {
  KnowledgeStatus,
  TransitionDefinition
} from "../../domain/knowledge.js";
import type { InteractionAction } from "../../domain/project-context.js";

export interface InteractionEdge {
  transition: TransitionDefinition;
  cost: number;
}

function baseCost(status: KnowledgeStatus): number {
  switch (status) {
    case "verified":
      return 1;
    case "observed":
      return 2;
    case "inferred":
      return 4;
  }
}

export function transitionCost(transition: TransitionDefinition): number {
  const { attempts, successes, recoveryCost } = transition.observations;
  const failurePenalty = attempts === 0
    ? 0.5
    : (1 - successes / attempts) * 5;
  return baseCost(transition.status) + failurePenalty + recoveryCost;
}

export class InteractionGraph {
  private readonly outgoing = new Map<string, InteractionEdge[]>();

  public constructor(
    transitions: readonly TransitionDefinition[],
    allowedActions?: readonly InteractionAction[]
  ) {
    const allowed = allowedActions === undefined
      ? undefined
      : new Set<string>(allowedActions);
    for (const transition of transitions) {
      if (allowed !== undefined && !allowed.has(transition.action.action)) {
        continue;
      }
      const entries = this.outgoing.get(transition.fromScreen) ?? [];
      entries.push({ transition, cost: transitionCost(transition) });
      this.outgoing.set(transition.fromScreen, entries);
    }
    for (const entries of this.outgoing.values()) {
      entries.sort((left, right) => (
        left.cost - right.cost
        || left.transition.id.localeCompare(right.transition.id)
      ));
    }
  }

  public readonly edgesFrom = (screenId: string): readonly InteractionEdge[] => (
    this.outgoing.get(screenId) ?? []
  );
}
