import { describe, expect, it } from "vitest";

import {
  RiskEvaluator
} from "../../../src/application/generation/risk-evaluator.js";
import type { InteractionPolicy } from "../../../src/domain/project-context.js";

function policy(
  overrides: Partial<InteractionPolicy> = {}
): InteractionPolicy {
  return {
    allowedActions: [],
    confirmationRequiredActions: [],
    forbiddenActions: [],
    ...overrides
  };
}

describe("RiskEvaluator", () => {
  const evaluator = new RiskEvaluator();

  it("gives the forbidden list precedence", () => {
    expect(evaluator.evaluate("click", policy({
      allowedActions: ["click"],
      confirmationRequiredActions: ["click"],
      forbiddenActions: ["click"]
    }))).toEqual({ effectiveRisk: "forbidden" });
  });

  it("requires confirmation for explicitly configured actions", () => {
    expect(evaluator.evaluate("click", policy({
      allowedActions: ["click"],
      confirmationRequiredActions: ["click"]
    }))).toEqual({ effectiveRisk: "confirmationRequired" });
  });

  it("allows only explicitly allowed actions without confirmation", () => {
    expect(evaluator.evaluate("click", policy({
      allowedActions: ["click"]
    }))).toEqual({ effectiveRisk: "safe" });
  });

  it("defaults unknown or unlisted actions to confirmation", () => {
    expect(evaluator.evaluate("wait", policy())).toEqual({
      effectiveRisk: "confirmationRequired"
    });
  });
});
