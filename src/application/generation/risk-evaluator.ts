import type { ProposedStep } from "../../domain/proposed-step.js";
import type { InteractionPolicy } from "../../domain/project-context.js";

export type EffectiveRisk =
  | "safe"
  | "confirmationRequired"
  | "forbidden";

export interface RiskEvaluation {
  effectiveRisk: EffectiveRisk;
}

export class RiskEvaluator {
  public evaluate(
    action: ProposedStep["action"],
    policy: InteractionPolicy
  ): RiskEvaluation {
    if (policy.forbiddenActions.includes(action)) {
      return { effectiveRisk: "forbidden" };
    }
    if (policy.confirmationRequiredActions.includes(action)) {
      return { effectiveRisk: "confirmationRequired" };
    }
    if (policy.allowedActions.includes(action)) {
      return { effectiveRisk: "safe" };
    }
    return { effectiveRisk: "confirmationRequired" };
  }
}
