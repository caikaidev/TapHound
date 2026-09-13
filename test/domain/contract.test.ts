import { describe, expect, it } from "vitest";

import {
  AcceptanceContractSchema,
  ContractReviewInputSchema,
  ContractVerdictViewSchema
} from "../../src/domain/contract.js";
import { hashJourney } from "../../src/domain/report.js";
import { JourneySchema } from "../../src/domain/journey.js";

const journeyFixture = {
  version: 2 as const,
  name: "Search",
  devices: [{ role: "default" }],
  steps: [{
    action: "click" as const,
    locator: { resourceId: "search" },
    activity: {
      before: "com.example.app.MainActivity",
      after: "com.example.app.SearchActivity"
    }
  }]
};

const validContract = {
  version: 1 as const,
  id: "search-opens",
  goal: "Tapping search opens the search screen",
  journey: {
    path: ".taphound/journeys/search.json",
    sha256: hashJourney(JourneySchema.parse(journeyFixture))
  },
  preconditions: [{ kind: "installed" as const }],
  assertions: [{
    type: "element" as const,
    locator: { resourceId: "search" },
    visibility: "visible" as const,
    timeoutMs: 2000
  }],
  evidenceRequirements: [{ kind: "screenshot" as const, scope: "final" as const }]
};

describe("AcceptanceContractSchema", () => {
  it("accepts a canonical contract", () => {
    const parsed = AcceptanceContractSchema.parse(validContract);
    expect(parsed.version).toBe(1);
    expect(parsed.assertions).toHaveLength(1);
    expect(parsed.evidenceRequirements[0]?.required).toBe(true);
    expect(parsed.evidenceRequirements[0]?.scope).toBe("final");
  });

  it("rejects duplicate precondition kinds", () => {
    const duplicate = {
      ...validContract,
      preconditions: [
        { kind: "installed" },
        { kind: "installed" }
      ]
    };
    expect(AcceptanceContractSchema.safeParse(duplicate).success).toBe(false);
  });

  it("rejects duplicate evidence requirement keys", () => {
    const duplicate = {
      ...validContract,
      evidenceRequirements: [
        { kind: "screenshot", scope: "final" },
        { kind: "screenshot", scope: "final" }
      ]
    };
    expect(AcceptanceContractSchema.safeParse(duplicate).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    const withExtra = { ...validContract, extra: true };
    expect(AcceptanceContractSchema.safeParse(withExtra).success).toBe(false);
  });

  it("rejects a journey binding with a non-hash sha256", () => {
    const bad = {
      ...validContract,
      journey: {
        path: ".taphound/journeys/search.json",
        sha256: "not-a-hash"
      }
    };
    expect(AcceptanceContractSchema.safeParse(bad).success).toBe(false);
  });

  it("allows an empty precondition list and defaults evidence scope", () => {
    const parsed = AcceptanceContractSchema.parse({
      ...validContract,
      preconditions: [],
      evidenceRequirements: [{ kind: "logcat" }]
    });
    expect(parsed.preconditions).toEqual([]);
    expect(parsed.evidenceRequirements[0]?.scope).toBe("final");
    expect(parsed.evidenceRequirements[0]?.required).toBe(true);
  });
});

describe("ContractVerdictViewSchema", () => {
  it("accepts a pass verdict view", () => {
    const view = {
      version: 1 as const,
      contractId: "search-opens",
      contractSha256: "a".repeat(64),
      journeySha256: "b".repeat(64),
      verdict: "pass" as const,
      reason: "CONTRACT_OK" as const,
      message: "ok",
      preconditions: [{ kind: "installed" as const, status: "passed" as const }],
      assertions: [{
        type: "element" as const,
        status: "passed" as const
      }],
      evidence: [{
        kind: "screenshot" as const,
        required: true,
        satisfied: true
      }],
      reportPath: "/runs/run-1/report.json",
      reportStatus: "passed" as const,
      startedAt: "2026-07-19T10:00:00.000Z",
      finishedAt: "2026-07-19T10:00:05.000Z",
      environment: {
        projectRoot: "/project",
        packageName: "com.example.app",
        devices: ["emulator-5554"]
      }
    };
    expect(ContractVerdictViewSchema.parse(view).verdict).toBe("pass");
  });

  it("rejects an unknown verdict reason", () => {
    const view = {
      version: 1,
      contractId: "search-opens",
      contractSha256: "a".repeat(64),
      journeySha256: "b".repeat(64),
      verdict: "invalid",
      reason: "NOT_A_REASON",
      message: "bad",
      preconditions: [],
      assertions: [],
      evidence: [],
      startedAt: "2026-07-19T10:00:00.000Z",
      finishedAt: "2026-07-19T10:00:05.000Z",
      environment: {
        projectRoot: "/project",
        packageName: "com.example.app",
        devices: ["emulator-5554"]
      }
    };
    expect(ContractVerdictViewSchema.safeParse(view).success).toBe(false);
  });
});
describe("Contract review schema", () => {
  const finding = {
    finding: "possible_overlap",
    region: "bottom_action_bar",
    description: "Send button appears partially covered by keyboard",
    confidence: 0.89,
    recommendedAction: "review" as const
  };

  it("accepts a canonical review input", () => {
    const parsed = ContractReviewInputSchema.parse({
      version: 1,
      source: "semantic-reviewer",
      model: "gpt-4o",
      promptVersion: "7",
      findings: [finding]
    });
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.source).toBe("semantic-reviewer");
  });

  it("defaults recommendedAction to review", () => {
    const { recommendedAction: _omitted, ...rest } = finding;
    void _omitted;
    const parsed = ContractReviewInputSchema.parse({
      version: 1,
      source: "reviewer",
      findings: [rest]
    });
    expect(parsed.findings[0]?.recommendedAction).toBe("review");
  });

  it("rejects empty findings", () => {
    expect(ContractReviewInputSchema.safeParse({
      version: 1,
      source: "reviewer",
      findings: []
    }).success).toBe(false);
  });

  it("rejects unknown fields on findings", () => {
    expect(ContractReviewInputSchema.safeParse({
      version: 1,
      source: "reviewer",
      findings: [{ ...finding, extra: true }]
    }).success).toBe(false);
  });

  it("accepts needsReview verdict with REVIEW_FINDINGS reason", () => {
    const view = {
      version: 1,
      contractId: "search-opens",
      contractSha256: "a".repeat(64),
      journeySha256: "b".repeat(64),
      verdict: "needsReview",
      reason: "REVIEW_FINDINGS",
      message: "reviewer requires human review",
      preconditions: [],
      assertions: [],
      evidence: [],
      startedAt: "2026-07-19T10:00:00.000Z",
      finishedAt: "2026-07-19T10:00:05.000Z",
      environment: {
        projectRoot: "/project",
        packageName: "com.example.app",
        devices: ["emulator-5554"]
      }
    };
    expect(ContractVerdictViewSchema.parse(view).verdict).toBe("needsReview");
  });

  it("accepts provenance and a review record", () => {
    const view = {
      version: 1,
      contractId: "search-opens",
      contractSha256: "a".repeat(64),
      journeySha256: "b".repeat(64),
      verdict: "needsReview",
      reason: "REVIEW_FINDINGS",
      message: "review",
      preconditions: [],
      assertions: [],
      evidence: [],
      startedAt: "2026-07-19T10:00:00.000Z",
      finishedAt: "2026-07-19T10:00:05.000Z",
      environment: {
        projectRoot: "/project",
        packageName: "com.example.app",
        devices: ["emulator-5554"]
      },
      provenance: {
        policyVersion: "1",
        taphoundVersion: "0.2.0-dev.6",
        toolVersions: { adb: "1.0.41", node: "24.3.0" }
      },
      review: {
        version: 1,
        source: "reviewer",
        findings: [finding],
        appliedAt: "2026-07-19T10:00:06.000Z",
        applied: true,
        baseVerdict: "pass",
        baseReason: "CONTRACT_OK"
      }
    };
    const parsed = ContractVerdictViewSchema.parse(view);
    expect(parsed.provenance?.policyVersion).toBe("1");
    expect(parsed.review?.applied).toBe(true);
    expect(parsed.review?.baseVerdict).toBe("pass");
  });

  it("rejects a review record with a verdict that cannot be a baseVerdict", () => {
    const view = {
      version: 1,
      contractId: "search-opens",
      contractSha256: "a".repeat(64),
      journeySha256: "b".repeat(64),
      verdict: "pass",
      reason: "CONTRACT_OK",
      message: "ok",
      preconditions: [],
      assertions: [],
      evidence: [],
      startedAt: "2026-07-19T10:00:00.000Z",
      finishedAt: "2026-07-19T10:00:05.000Z",
      environment: {
        projectRoot: "/project",
        packageName: "com.example.app",
        devices: ["emulator-5554"]
      },
      review: {
        version: 1,
        source: "reviewer",
        findings: [finding],
        appliedAt: "2026-07-19T10:00:06.000Z",
        applied: true,
        baseVerdict: "not-a-verdict",
        baseReason: "CONTRACT_OK"
      }
    };
    expect(ContractVerdictViewSchema.safeParse(view).success).toBe(false);
  });
});
