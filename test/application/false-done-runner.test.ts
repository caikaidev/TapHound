import { describe, expect, it, vi } from "vitest";

import { FalseDoneRunner } from "../../src/application/benchmark/false-done-runner.js";
import type { ContractVerifyResult } from "../../src/application/contract/contract-verifier.js";
import type { ContractVerdictView } from "../../src/domain/contract.js";
import type { FalseDoneCase, FalseDoneRunResult } from "../../src/domain/false-done.js";
import type { FalseDoneStore } from "../../src/ports/false-done-store.js";
import { hashJourney } from "../../src/domain/report.js";

const JOURNEY_TEXT = JSON.stringify({
  version: 2,
  name: "Search",
  devices: [{ role: "default" }],
  steps: [{
    action: "click",
    locator: { resourceId: "search" },
    activity: {
      before: "com.example.app.MainActivity",
      after: "com.example.app.SearchActivity"
    }
  }]
});
const journeyHash = hashJourney(JSON.parse(JOURNEY_TEXT));

const CONTRACT_TEXT = JSON.stringify({
  version: 1,
  id: "fd-case-x",
  goal: "Search produces results",
  journey: { path: ".taphound/journeys/search.json", sha256: journeyHash },
  preconditions: [{ kind: "installed" }],
  assertions: [{
    type: "element",
    locator: { resourceId: "result_list" },
    visibility: "visible",
    timeoutMs: 2000
  }]
});

function view(verdict: ContractVerdictView["verdict"]): ContractVerdictView {
  return {
    version: 1,
    contractId: "fd-case-x",
    contractSha256: "c".repeat(64),
    journeySha256: journeyHash,
    verdict,
    reason: verdict === "pass"
      ? "CONTRACT_OK"
      : verdict === "fail" ? "RUN_FAILED" : "RUN_ERROR",
    message: verdict,
    preconditions: [{ kind: "installed", status: "passed" }],
    assertions: [{
      type: "element",
      status: verdict === "pass" ? "passed" : "failed"
    }],
    evidence: [{
      kind: "screenshot",
      required: true,
      satisfied: verdict !== "inconclusive"
    }],
    reportPath: "/runs/run-1/report.json",
    reportStatus: verdict === "pass" ? "passed" : "failed",
    startedAt: "2026-09-13T10:00:00.000Z",
    finishedAt: "2026-09-13T10:00:05.000Z",
    environment: {
      projectRoot: "/project",
      packageName: "com.example.app",
      devices: ["emulator-5554"]
    }
  };
}

function caseFor(
  id: string,
  category: FalseDoneCase["category"],
  expectedVerdict: FalseDoneCase["expectedVerdict"]
): FalseDoneCase {
  return {
    version: 1,
    id,
    category,
    description: id,
    variant: { label: `variant-${id}`, apkPath: `variants/${id}.apk` },
    contractPath: ".taphound/contracts/fd-case-x.json",
    expectedVerdict,
    tags: []
  };
}

function store(cases: readonly FalseDoneCase[]): FalseDoneStore {
  return {
    readCases: vi.fn((): Promise<readonly FalseDoneCase[]> => (
      Promise.resolve([...cases])
    )),
    writeResult: vi.fn((input: {
      result: FalseDoneRunResult;
    }): Promise<string> => Promise.resolve(
      `.taphound/build/false-done-runs/${input.result.runId}.json`
    )),
    readResult: vi.fn((_projectRoot: string, runId: string): Promise<FalseDoneRunResult> => {
      void _projectRoot;
      return Promise.resolve({
        version: 1,
        runId,
        startedAt: "2026-09-13T10:00:00.000Z",
        completedAt: "2026-09-13T10:00:05.000Z",
        deviceSerial: "emulator-5554",
        repeats: 1,
        results: [],
        metrics: {
          eligibleCases: 0,
          falseDoneExpected: 0,
          falseDoneDetected: 0,
          falseDoneRecall: null,
          missedCount: 0,
          falseRejectCount: 0,
          falseRejectRate: null,
          verdictAgreementRate: null,
          errorCount: 0,
          replayStabilityRate: null,
          anchorUnresolvedTotal: 0,
          evidenceInsufficientTotal: 0
        }
      });
    })
  };
}

function makeRunner(options: {
  cases: readonly FalseDoneCase[];
  verdicts: readonly ContractVerdictView["verdict"][];
  installFail?: boolean;
  readTextFiles?: Record<string, string>;
}): {
  runner: FalseDoneRunner;
  installApk: ReturnType<typeof vi.fn>;
  verifyContract: ReturnType<typeof vi.fn>;
} {
  const installApk = vi.fn((input: {
    deviceSerial: string;
    apkPath: string;
  }): Promise<void> => {
    void input;
    if (options.installFail === true) {
      return Promise.reject(new Error("adb install failed"));
    }
    return Promise.resolve();
  });
  const queue = [...options.verdicts];
  const verifyContract = vi.fn((): Promise<ContractVerifyResult> => {
    const verdict = queue.shift() ?? "pass";
    return Promise.resolve({
      view: view(verdict),
      exitCode: verdict === "pass" ? 0 : 1
    });
  });
  const runner = new FalseDoneRunner({
    store: store(options.cases),
    installApk,
    verifyContract,
    readText: vi.fn((path: string): Promise<string> => {
      if (path.endsWith("fd-case-x.json")) {
        return Promise.resolve(CONTRACT_TEXT);
      }
      if (path.endsWith("search.json")) {
        return Promise.resolve(JOURNEY_TEXT);
      }
      return Promise.resolve(options.readTextFiles?.[path] ?? CONTRACT_TEXT);
    }),
    readBytes: vi.fn((path: string): Promise<Uint8Array> => {
      void path;
      return Promise.resolve(new Uint8Array([1, 2, 3, 4]));
    }),
    now: (): Date => new Date("2026-09-13T10:00:00.000Z"),
    createRunId: (): string => "fd-run-1"
  });
  return { runner, installApk, verifyContract };
}

describe("FalseDoneRunner", () => {
  it("scores confirmed / detected / missed / falseReject correctly", async () => {
    const cases = [
      caseFor("correct-01", "correct", "pass"),
      caseFor("behavior-01", "behavior", "fail"),
      caseFor("visual-01", "visual", "fail"),
      caseFor("boundary-01", "boundary", "inconclusive")
    ];
    const { runner } = makeRunner({
      cases,
      verdicts: ["pass", "fail", "pass", "inconclusive"]
    });
    const { result } = await runner.run({
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      config: {
        version: 1,
        run: { packageName: "com.example.app", activity: ".MainActivity" },
        idle: {
          strategy: "hybrid",
          pollIntervalMs: 100,
          stablePolls: 1,
          timeoutMs: 1000
        },
        artifactsDir: ".taphound/build/runs"
      },
      toolVersions: { node: "24.3.0" }
    });
    const detections = Object.fromEntries(
      result.results.map((entry) => [entry.caseId, entry.detection])
    );
    expect(detections).toEqual({
      "correct-01": "confirmed",
      "behavior-01": "detected",
      "visual-01": "missed",
      "boundary-01": "detected"
    });
    expect(result.metrics).toMatchObject({
      eligibleCases: 4,
      falseDoneExpected: 3,
      falseDoneDetected: 2,
      falseDoneRecall: 2 / 3,
      missedCount: 1,
      falseRejectCount: 0,
      falseRejectRate: 0,
      verdictAgreementRate: 3 / 4
    });
  });

  it("scores a false reject when a correct case fails verification", async () => {
    const { runner } = makeRunner({
      cases: [caseFor("correct-01", "correct", "pass")],
      verdicts: ["fail"]
    });
    const { result } = await runner.run({
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      config: {
        version: 1,
        run: { packageName: "com.example.app", activity: ".MainActivity" },
        idle: {
          strategy: "hybrid",
          pollIntervalMs: 100,
          stablePolls: 1,
          timeoutMs: 1000
        },
        artifactsDir: ".taphound/build/runs"
      },
      toolVersions: {}
    });
    expect(result.results[0]?.detection).toBe("falseReject");
    expect(result.metrics.falseRejectCount).toBe(1);
    expect(result.metrics.falseRejectRate).toBe(1);
  });

  it("records an error when the variant APK install fails", async () => {
    const { runner } = makeRunner({
      cases: [caseFor("behavior-01", "behavior", "fail")],
      verdicts: ["fail"],
      installFail: true
    });
    const { result } = await runner.run({
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      config: {
        version: 1,
        run: { packageName: "com.example.app", activity: ".MainActivity" },
        idle: {
          strategy: "hybrid",
          pollIntervalMs: 100,
          stablePolls: 1,
          timeoutMs: 1000
        },
        artifactsDir: ".taphound/build/runs"
      },
      toolVersions: {}
    });
    expect(result.results[0]?.detection).toBe("error");
    expect(result.metrics.errorCount).toBe(1);
    expect(result.results[0]?.error).toContain("adb install failed");
  });

  it("measures replay stability across repeated verifications", async () => {
    const { runner, verifyContract } = makeRunner({
      cases: [caseFor("behavior-01", "behavior", "fail")],
      verdicts: ["fail", "fail"]
    });
    const { result } = await runner.run({
      projectRoot: "/project",
      deviceSerial: "emulator-5554",
      repeats: 2,
      config: {
        version: 1,
        run: { packageName: "com.example.app", activity: ".MainActivity" },
        idle: {
          strategy: "hybrid",
          pollIntervalMs: 100,
          stablePolls: 1,
          timeoutMs: 1000
        },
        artifactsDir: ".taphound/build/runs"
      },
      toolVersions: {}
    });
    const entry = result.results[0];
    expect(entry?.attempts).toBe(2);
    expect(entry?.stableAcrossAttempts).toBe(true);
    expect(result.metrics.replayStabilityRate).toBe(1);
    expect(verifyContract).toHaveBeenCalledTimes(2);
    expect(result.repeats).toBe(2);
  });

  it("validates case packs including the bound Contract", async () => {
    const { runner } = makeRunner({
      cases: [caseFor("behavior-01", "behavior", "fail")],
      verdicts: ["fail"]
    });
    const output = await runner.validate({ projectRoot: "/project" });
    expect(output.status).toBe("valid");
    expect(output.cases).toEqual([{
      id: "behavior-01",
      ok: true,
      issues: []
    }]);
  });

  it("reports an issue when a pass-expected case is not category=correct", async () => {
    const { runner } = makeRunner({
      cases: [caseFor("behavior-01", "behavior", "pass")],
      verdicts: ["pass"]
    });
    const output = await runner.validate({ projectRoot: "/project" });
    expect(output.status).toBe("invalid");
    expect(output.cases[0]?.ok).toBe(false);
    expect(output.cases[0]?.issues[0]).toContain("category=correct");
  });
});