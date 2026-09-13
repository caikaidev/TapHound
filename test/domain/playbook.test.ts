import { describe, expect, it } from "vitest";

import {
  EscalationPolicySchema,
  PlaybookDefinitionSchema,
  type EscalationPolicy
} from "../../src/domain/playbook.js";

const validPolicy: EscalationPolicy = {
  version: 1,
  rules: [{
    id: "deterministic-fail",
    when: { verdicts: ["fail"] },
    then: { action: "verdict", result: "fail" }
  }, {
    id: "ambiguous-evidence",
    when: { reasons: ["ASSERTION_UNRESOLVED"] },
    then: { action: "escalate", target: "semantic" }
  }, {
    id: "review-findings",
    when: { verdicts: ["pass"] },
    then: { action: "verdict", result: "needsReview" }
  }]
};

const validPlaybook = {
  version: 1 as const,
  id: "search-fd",
  kind: "behavior-regression" as const,
  goal: "Search results survive a detail round trip",
  phases: [
    "contract-verify" as const,
    "baseline-capture" as const,
    "change-apply" as const,
    "replay-journey" as const,
    "baseline-compare" as const,
    "evidence-collect" as const,
    "verdict-apply" as const
  ],
  contract: {
    path: ".taphound/contracts/fd-search-results.json",
    sha256: "a".repeat(64)
  },
  evidenceRequirements: [{
    kind: "screenshot" as const,
    scope: "final" as const,
    required: true
  }],
  passCondition: "baseline-compare reports no regression",
  failCondition: "baseline-compare reports a regression",
  inconclusiveCondition: "baseline evidence is unavailable",
  escalation: validPolicy
};

describe("PlaybookDefinitionSchema", () => {
  it("accepts a canonical playbook", () => {
    const parsed = PlaybookDefinitionSchema.parse(validPlaybook);
    expect(parsed.kind).toBe("behavior-regression");
    expect(parsed.phases).toContain("baseline-compare");
    expect(parsed.escalation.rules).toHaveLength(3);
  });

  it("rejects duplicate phases", () => {
    expect(PlaybookDefinitionSchema.safeParse({
      ...validPlaybook,
      phases: ["contract-verify", "contract-verify"]
    }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(PlaybookDefinitionSchema.safeParse({
      ...validPlaybook,
      extra: true
    }).success).toBe(false);
  });

  it("rejects a non-version-1 playbook", () => {
    expect(PlaybookDefinitionSchema.safeParse({
      ...validPlaybook,
      version: 2
    }).success).toBe(false);
  });

  it("rejects an empty phases list", () => {
    expect(PlaybookDefinitionSchema.safeParse({
      ...validPlaybook,
      phases: []
    }).success).toBe(false);
  });
});

describe("EscalationPolicySchema", () => {
  it("accepts a policy mixing verdict and escalate actions", () => {
    const parsed = EscalationPolicySchema.parse(validPolicy);
    expect(parsed.rules[1]?.then).toEqual({
      action: "escalate",
      target: "semantic"
    });
  });

  it("rejects a rule with no signals", () => {
    expect(EscalationPolicySchema.safeParse({
      version: 1,
      rules: [{ id: "empty", when: {}, then: { action: "verdict", result: "fail" } }]
    }).success).toBe(false);
  });

  it("rejects duplicate rule ids", () => {
    expect(EscalationPolicySchema.safeParse({
      version: 1,
      rules: [
        { id: "dup", when: { verdicts: ["fail"] }, then: { action: "verdict", result: "fail" } },
        { id: "dup", when: { verdicts: ["pass"] }, then: { action: "verdict", result: "pass" } }
      ]
    }).success).toBe(false);
  });

  it("rejects an unknown escalate target", () => {
    expect(EscalationPolicySchema.safeParse({
      version: 1,
      rules: [{ id: "r", when: { verdicts: ["pass"] }, then: { action: "escalate", target: "vision" } }]
    }).success).toBe(false);
  });
});