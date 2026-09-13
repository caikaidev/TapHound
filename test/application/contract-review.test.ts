import { describe, expect, it } from "vitest";

import { ContractReviewMerger } from "../../src/application/contract/contract-review.js";
import type {
  ContractReviewInput,
  ContractVerdictView
} from "../../src/domain/contract.js";

const NOW = "2026-07-19T10:00:06.000Z";

function view(verdict: ContractVerdictView["verdict"]): ContractVerdictView {
  return {
    version: 1,
    contractId: "search-opens",
    contractSha256: "a".repeat(64),
    journeySha256: "b".repeat(64),
    verdict,
    reason: verdict === "pass" ? "CONTRACT_OK" : verdict === "invalid" ? "CONTRACT_INVALID" : verdict === "fail" ? "ASSERTION_FAILED" : "EVIDENCE_INSUFFICIENT",
    message: "base verdict",
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
}

function reviewInput(source = "semantic-reviewer"): ContractReviewInput {
  return {
    version: 1,
    source,
    findings: [{
      finding: "possible_overlap",
      region: "bottom_action_bar",
      description: "Send button appears partially covered by keyboard",
      confidence: 0.89,
      recommendedAction: "review"
    }]
  };
}

describe("ContractReviewMerger", () => {
  const merger = new ContractReviewMerger({
    now: (): Date => new Date(NOW)
  });

  it("escalates a pass verdict to needsReview", async () => {
    const result = await merger.merge({
      view: view("pass"),
      review: reviewInput()
    });
    expect(result.applied).toBe(true);
    expect(result.view.verdict).toBe("needsReview");
    expect(result.view.reason).toBe("REVIEW_FINDINGS");
    expect(result.view.review?.baseVerdict).toBe("pass");
    expect(result.view.review?.baseReason).toBe("CONTRACT_OK");
    expect(result.view.review?.appliedAt).toBe(NOW);
  });

  it("escalates an inconclusive verdict to needsReview", async () => {
    const result = await merger.merge({
      view: view("inconclusive"),
      review: reviewInput()
    });
    expect(result.applied).toBe(true);
    expect(result.view.verdict).toBe("needsReview");
    expect(result.view.review?.baseVerdict).toBe("inconclusive");
  });

  it("never rewrites a deterministic fail verdict", async () => {
    const result = await merger.merge({
      view: view("fail"),
      review: reviewInput()
    });
    expect(result.applied).toBe(false);
    expect(result.view.verdict).toBe("fail");
    expect(result.view.reason).toBe("ASSERTION_FAILED");
    expect(result.view.review?.applied).toBe(false);
    expect(result.view.review?.baseVerdict).toBe("fail");
  });

  it("never rewrites an invalid verdict", async () => {
    const result = await merger.merge({
      view: view("invalid"),
      review: reviewInput()
    });
    expect(result.applied).toBe(false);
    expect(result.view.verdict).toBe("invalid");
    expect(result.view.review?.applied).toBe(false);
  });

  it("keeps needsReview when findings are merged again", async () => {
    const first = await merger.merge({
      view: view("pass"),
      review: reviewInput("reviewer-a")
    });
    const second = await merger.merge({
      view: first.view,
      review: reviewInput("reviewer-b")
    });
    expect(second.applied).toBe(true);
    expect(second.view.verdict).toBe("needsReview");
    expect(second.view.review?.findings).toHaveLength(2);
    expect(second.view.review?.source).toBe("reviewer-b");
  });
});