import { describe, expect, it, vi, type Mock } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import type {
  ContractReviewInput,
  ContractVerdictView
} from "../../src/domain/contract.js";
import type { ContractReviewMergeResult } from "../../src/application/contract/contract-review.js";
import type { ObserveInput } from "../../src/application/observe/observe-service.js";
import type { ObserveReport } from "../../src/domain/observation.js";
import { runtimeConfig, runtimeJourney } from "../fakes/runtime-fixture.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";
import { defaultLocalTargets } from "../fakes/local-targets.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

const NOW = "2026-07-19T10:00:06.000Z";

function baseVerdict(): ContractVerdictView {
  return {
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
    }
  };
}

const findings: ContractReviewInput = {
  version: 1,
  source: "semantic-reviewer",
  findings: [{
    finding: "possible_overlap",
    region: "bottom_action_bar",
    description: "Send button appears partially covered by keyboard",
    confidence: 0.89,
    recommendedAction: "review"
  }]
};

interface ReviewMocks {
  merge: Mock<(input: {
    view: ContractVerdictView;
    review: ContractReviewInput;
  }) => Promise<ContractReviewMergeResult>>;
  writeVerdict: Mock<(input: {
    verdictPath: string;
    view: ContractVerdictView;
  }) => Promise<void>>;
}

function applyMerge(
  mocks: ReviewMocks,
  input: { view: ContractVerdictView; review: ContractReviewInput }
): ContractReviewMergeResult {
  const applied = input.view.verdict !== "fail" && input.view.verdict !== "invalid";
  return {
    view: {
      ...input.view,
      ...(applied
        ? {
            verdict: "needsReview" as const,
            reason: "REVIEW_FINDINGS" as const,
            message: `Reviewer ${input.review.source} found ${String(input.review.findings.length)} finding(s) requiring human review`
          }
        : {}),
      review: {
        version: 1,
        source: input.review.source,
        findings: input.review.findings,
        appliedAt: NOW,
        applied,
        baseVerdict: input.view.verdict,
        baseReason: input.view.reason
      }
    },
    applied
  };
}

function baseDependencies(
  exitCodes: number[],
  stored: { view: ContractVerdictView },
  mocks: ReviewMocks
): CliDependencies {
  return {
    doctor: {
      run: vi.fn(() => Promise.resolve({
        status: "passed" as const,
        runtimeBackend: "adb" as const,
        deviceSerial: "emulator-5554",
        checks: [
          { name: "node" as const, status: "passed" as const, version: "24.3.0" },
          { name: "adb" as const, status: "passed" as const, version: "1.0.41" },
          { name: "android" as const, status: "passed" as const, version: "0.1.0" }
        ]
      }))
    },
    recorder: { record: vi.fn() },
    verifier: { verify: vi.fn() },
    contractReview: {
      merge: mocks.merge,
      writeVerdict: mocks.writeVerdict
    },
    projectDescriber: { describe: vi.fn() },
    contextValidator: { validate: vi.fn() },
    contextLoader: { load: vi.fn(), readIndex: vi.fn() },
    contextRefresher: { refresh: vi.fn() },
    contextGenerator: { generate: vi.fn() },
    contextRehasher: { rehash: vi.fn() },
    init: { install: vi.fn() },
    initPrompt: { selectAgents: vi.fn() },
    align: { alignCamera: vi.fn() },
    observer: (): {
      observe: (input: ObserveInput) => Promise<ObserveReport>;
    } => ({ observe: vi.fn() }),
    generationStarter: { start: vi.fn() },
    runtimeObserver: { observe: vi.fn() },
    workspaceLayout: fakeWorkspaceLayout(),
    localTargets: defaultLocalTargets(),
    readJson: vi.fn((path: string): Promise<unknown> => {
      if (path.endsWith("verdict.json")) {
        return Promise.resolve(stored.view);
      }
      if (path.endsWith("findings.json")) {
        return Promise.resolve(findings);
      }
      return Promise.resolve(path.includes("journey")
        ? runtimeJourney
        : runtimeConfig);
    }),
    cwd: () => "/project",
    stdout: new BufferOutput(),
    stderr: new BufferOutput(),
    setExitCode: (code): void => {
      exitCodes.push(code);
    }
  };
}

describe("contract review", () => {
  it("merges findings into a pass verdict and rewrites verdict.json", async () => {
    const exitCodes: number[] = [];
    const stored = { view: baseVerdict() };
    const mocks: ReviewMocks = {
      merge: vi.fn((input: {
        view: ContractVerdictView;
        review: ContractReviewInput;
      }): Promise<ContractReviewMergeResult> => (
        Promise.resolve(applyMerge(mocks, input))
      )),
      writeVerdict: vi.fn((input: {
        verdictPath: string;
        view: ContractVerdictView;
      }): Promise<void> => {
        stored.view = input.view;
        return Promise.resolve();
      })
    };
    const dependencies = baseDependencies(exitCodes, stored, mocks);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "contract", "review",
      "--verdict", "runs/run-1/verdict.json",
      "--findings", "runs/run-1/findings.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([1]);
    const output = JSON.parse((dependencies.stdout as BufferOutput).value) as {
      verdict: string;
      reason: string;
      review: { applied: boolean };
    };
    expect(output.verdict).toBe("needsReview");
    expect(output.reason).toBe("REVIEW_FINDINGS");
    expect(output.review.applied).toBe(true);
    expect(stored.view.verdict).toBe("needsReview");
    const [writeInput] = mocks.writeVerdict.mock.calls[0] as [{
      verdictPath: string;
      view: ContractVerdictView;
    }];
    expect(writeInput.verdictPath).toBe("/project/runs/run-1/verdict.json");
  });

  it("never upgrades a fail verdict and exits 1", async () => {
    const exitCodes: number[] = [];
    const stored: { view: ContractVerdictView } = {
      view: {
        ...baseVerdict(),
        verdict: "fail",
        reason: "ASSERTION_FAILED",
        message: "assertion failed"
      }
    };
    const mocks: ReviewMocks = {
      merge: vi.fn((input: {
        view: ContractVerdictView;
        review: ContractReviewInput;
      }): Promise<ContractReviewMergeResult> => (
        Promise.resolve(applyMerge(mocks, input))
      )),
      writeVerdict: vi.fn((input: {
        verdictPath: string;
        view: ContractVerdictView;
      }): Promise<void> => {
        stored.view = input.view;
        return Promise.resolve();
      })
    };
    const dependencies = baseDependencies(exitCodes, stored, mocks);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "contract", "review",
      "--verdict", "runs/run-1/verdict.json",
      "--findings", "runs/run-1/findings.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([1]);
    const output = JSON.parse((dependencies.stdout as BufferOutput).value) as {
      verdict: string;
      review: { applied: boolean };
    };
    expect(output.verdict).toBe("fail");
    expect(output.review.applied).toBe(false);
    expect(stored.view.verdict).toBe("fail");
  });

  it("emits a failure when findings are malformed", async () => {
    const exitCodes: number[] = [];
    const stored = { view: baseVerdict() };
    const mocks: ReviewMocks = {
      merge: vi.fn((): Promise<ContractReviewMergeResult> => (
        Promise.resolve({ view: stored.view, applied: false })
      )),
      writeVerdict: vi.fn((input: {
        verdictPath: string;
        view: ContractVerdictView;
      }): Promise<void> => {
        stored.view = input.view;
        return Promise.resolve();
      })
    };
    const dependencies = baseDependencies(exitCodes, stored, mocks);
    dependencies.readJson = vi.fn((path: string): Promise<unknown> => {
      if (path.endsWith("findings.json")) {
        return Promise.resolve({ version: 1, source: "r" });
      }
      return Promise.resolve(stored.view);
    });
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "contract", "review",
      "--verdict", "runs/run-1/verdict.json",
      "--findings", "runs/run-1/findings.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([2]);
    const output = JSON.parse((dependencies.stdout as BufferOutput).value) as {
      failure: { code: string };
    };
    expect(output.failure.code).toBe("CONTRACT_INVALID");
  });
});