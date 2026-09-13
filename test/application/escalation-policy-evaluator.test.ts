import { describe, expect, it } from "vitest";

import { EscalationPolicyEvaluator } from "../../src/application/playbook/escalation-policy-evaluator.js";
import type { EscalationPolicy } from "../../src/domain/playbook.js";
import type { ContractVerdict, ContractVerdictReason } from "../../src/domain/contract.js";

const policy: EscalationPolicy = {
  version: 1,
  rules: [{
    id: "deterministic-fail",
    when: { verdicts: ["fail"] },
    then: { action: "verdict", result: "fail" }
  }, {
    id: "ambiguous-evidence",
    when: { reasons: ["ASSERTION_UNRESOLVED", "EVIDENCE_INSUFFICIENT"] },
    then: { action: "escalate", target: "semantic" }
  }, {
    id: "visual-only",
    when: { verdicts: ["pass"] },
    then: { action: "escalate", target: "multimodal" }
  }, {
    id: "fallback-inconclusive",
    when: { verdicts: ["inconclusive"] },
    then: { action: "verdict", result: "inconclusive" }
  }]
};

function signal(
  verdict: ContractVerdict,
  reason: ContractVerdictReason
): { verdict: ContractVerdict; reason: ContractVerdictReason } {
  return { verdict, reason };
}

describe("EscalationPolicyEvaluator", () => {
  const evaluator = new EscalationPolicyEvaluator();

  it("first-match returns a verdict action", () => {
    const decision = evaluator.evaluate(policy, signal("fail", "ASSERTION_FAILED"));
    expect(decision).toEqual({
      matched: true,
      ruleId: "deterministic-fail",
      action: { action: "verdict", result: "fail" }
    });
  });

  it("matches on reason and escalates to semantic", () => {
    const decision = evaluator.evaluate(policy, signal("inconclusive", "ASSERTION_UNRESOLVED"));
    expect(decision).toEqual({
      matched: true,
      ruleId: "ambiguous-evidence",
      action: { action: "escalate", target: "semantic" }
    });
  });

  it("matches a pass verdict on the visual-only rule", () => {
    const decision = evaluator.evaluate(policy, signal("pass", "CONTRACT_OK"));
    expect(decision).toEqual({
      matched: true,
      ruleId: "visual-only",
      action: { action: "escalate", target: "multimodal" }
    });
  });

  it("matches on verdict when reason does not appear", () => {
    const decision = evaluator.evaluate(policy, signal("inconclusive", "RUN_ERROR"));
    expect(decision).toEqual({
      matched: true,
      ruleId: "fallback-inconclusive",
      action: { action: "verdict", result: "inconclusive" }
    });
  });

  it("returns unmatched when no rule matches", () => {
    const decision = evaluator.evaluate(policy, signal("invalid", "CONTRACT_INVALID"));
    expect(decision).toEqual({ matched: false });
  });

  it("respects rule order: earlier verdict rule wins over reason rule", () => {
    const ordered: EscalationPolicy = {
      version: 1,
      rules: [{
        id: "first",
        when: { verdicts: ["fail"] },
        then: { action: "verdict", result: "fail" }
      }, {
        id: "second",
        when: { reasons: ["ASSERTION_FAILED"] },
        then: { action: "verdict", result: "needsReview" }
      }]
    };
    const decision = evaluator.evaluate(ordered, signal("fail", "ASSERTION_FAILED"));
    expect(decision.matched).toBe(true);
    if (decision.matched) {
      expect(decision.ruleId).toBe("first");
    }
  });
});