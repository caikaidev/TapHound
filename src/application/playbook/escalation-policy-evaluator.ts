import type {
  ContractVerdict,
  ContractVerdictReason
} from "../../domain/contract.js";
import type {
  EscalationAction,
  EscalationPolicy,
  EscalationRule
} from "../../domain/playbook.js";

export interface EscalationSignal {
  verdict: ContractVerdict;
  reason: ContractVerdictReason;
}

export type EscalationDecision =
  | { matched: true; ruleId: string; action: EscalationAction }
  | { matched: false };

function matches(
  rule: EscalationRule,
  signal: EscalationSignal
): boolean {
  const { when } = rule;
  if (when.verdicts !== undefined && !when.verdicts.includes(signal.verdict)) {
    return false;
  }
  if (when.reasons !== undefined && !when.reasons.includes(signal.reason)) {
    return false;
  }
  return true;
}

/**
 * Evaluates an Escalation Policy against deterministic verdict signals.
 *
 * Rules are ordered; the first matching rule wins (`first-match`). The
 * policy decides *when* a result is escalated to an AI layer, so *when AI is
 * invoked must itself be deterministic* (architecture doc §19). No model is
 * called here: the evaluator only maps already-collected verdict/reason facts
 * to an explicit rule.
 *
 * Semantics:
 * - `verdict` action stops evaluation and is the final result;
 * - `escalate` action hands the run to the named layer (semantic /
 *   multimodal) and returns after the first match, so a playbook runner can
 *   attach the reviewer outcome and re-apply (see ContractReviewMerger).
 */
export class EscalationPolicyEvaluator {
  public readonly evaluate = (
    policy: EscalationPolicy,
    signal: EscalationSignal
  ): EscalationDecision => {
    for (const rule of policy.rules) {
      if (!matches(rule, signal)) {
        continue;
      }
      if (
        (signal.verdict === "fail" || signal.verdict === "invalid")
        && (
          rule.then.action !== "verdict"
          || rule.then.result !== signal.verdict
        )
      ) {
        return {
          matched: true,
          ruleId: "deterministic-verdict-is-final",
          action: { action: "verdict", result: signal.verdict }
        };
      }
      return { matched: true, ruleId: rule.id, action: rule.then };
    }
    return { matched: false };
  };
}