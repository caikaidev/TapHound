import { describe, expect, it } from "vitest";

import { BaselineService } from "../../src/application/checkpoint/baseline-service.js";
import { ContractVerdictViewSchema } from "../../src/domain/contract.js";
import type { TapHoundReport } from "../../src/domain/report.js";
import { validReport } from "../fixtures/report.js";

const reportPath = "/reports/source/report.json";
const currentPath = "/reports/current/report.json";
const baselinePath = "/baselines/search.json";
const contractSha256 = "b".repeat(64);

function sourceReport(overrides: Partial<TapHoundReport> = {}): TapHoundReport {
  const report = validReport({
    screens: [{ screen: "search", status: "matched" }],
    ...overrides
  });
  report.steps = report.steps.map((step) => ({
    ...step,
    locator: step.locator === undefined
      ? undefined
      : {
          ...step.locator,
          requested: { resourceId: "com.example.app:id/search" }
        }
  }));
  return report;
}

function passingVerdict(
  path: string,
  overrides: Record<string, unknown> = {}
): string {
  return JSON.stringify(ContractVerdictViewSchema.parse({
    version: 1,
    contractId: "search",
    contractSha256,
    journeySha256: "a".repeat(64),
    verdict: "pass",
    reason: "CONTRACT_OK",
    message: "Contract passed",
    preconditions: [],
    assertions: [],
    evidence: [],
    reportPath: path,
    reportStatus: "passed",
    startedAt: "2026-07-19T10:00:00.000Z",
    finishedAt: "2026-07-19T10:00:01.000Z",
    environment: {
      projectRoot: "/project",
      packageName: "com.example.app",
      devices: ["emulator-5554"]
    },
    ...overrides
  }));
}

function harness(input: {
  source?: TapHoundReport;
  current?: TapHoundReport;
} = {}): {
  files: Map<string, string>;
  service: BaselineService;
} {
  const files = new Map<string, string>([
    [reportPath, JSON.stringify(input.source ?? sourceReport())],
    [currentPath, JSON.stringify(input.current ?? sourceReport())]
  ]);
  const service = new BaselineService({
    readText: (path): Promise<string> => {
      const text = files.get(path);
      return text === undefined
        ? Promise.reject(new Error(`No file: ${path}`))
        : Promise.resolve(text);
    },
    writeText: (path, content): Promise<void> => {
      files.set(path, content);
      return Promise.resolve();
    },
    now: (): Date => new Date("2026-07-19T10:00:10.000Z")
  });
  return { files, service };
}

describe("BaselineService capture identity", () => {
  it("rejects a caller-supplied Journey hash that differs from the report", async () => {
    const { service } = harness();
    await expect(service.captureFromReport(reportPath, {
      journeySha256: "c".repeat(64)
    })).rejects.toMatchObject({ code: "BASELINE_INCOMPARABLE" });
  });

  it("requires a passing Verdict tied to the report before binding a Contract", async () => {
    const { files, service } = harness();
    await expect(service.captureFromReport(reportPath, {
      contractSha256
    })).rejects.toMatchObject({ code: "BASELINE_INCOMPARABLE" });
    files.set("/reports/source/verdict.json", passingVerdict(currentPath));
    await expect(service.captureFromReport(reportPath, {
      contractSha256
    })).rejects.toMatchObject({ code: "BASELINE_INCOMPARABLE" });
    files.set("/reports/source/verdict.json", passingVerdict(reportPath));
    const baseline = await service.captureFromReport(reportPath, {
      contractSha256
    });
    expect(baseline.contractSha256).toBe(contractSha256);
  });

  it("rejects a failed report and an empty fact set", async () => {
    const failed = harness({
      source: sourceReport({ status: "failed" })
    });
    await expect(failed.service.captureFromReport(reportPath, {}))
      .rejects.toMatchObject({ code: "BASELINE_INCOMPARABLE" });
    const empty = harness({
      source: sourceReport({ steps: [], screens: [] })
    });
    await expect(empty.service.captureFromReport(reportPath, {}))
      .rejects.toMatchObject({ code: "BASELINE_EMPTY" });
  });
});

describe("BaselineService comparison gates", () => {
  it("compares Checkpoint absence and rejects missing or unresolved current evidence", async () => {
    const checkpoint = {
      id: "search-ready",
      stepIndex: 0,
      status: "passed" as const,
      conditions: [{
        kind: "absentElement" as const,
        status: "passed" as const,
        locator: { resourceId: "loading" }
      }]
    };
    const test = harness({
      source: sourceReport({ checkpoints: [checkpoint] }),
      current: sourceReport({ checkpoints: [checkpoint] })
    });
    const baseline = await test.service.captureFromReport(reportPath, {});
    expect(baseline.checkpoints?.[0]).toMatchObject({
      checkpointId: "search-ready",
      kind: "absentElement"
    });
    await test.service.write({ path: baselinePath, baseline });
    expect((await test.service.compare({
      baselinePath, reportPath: currentPath
    })).coverage.checkpoints).toBe(1);
    const failedCheckpoint = sourceReport({
      status: "failed",
      layers: {
        run: "failed",
        structural: "passed",
        activityCheckpoint: "passed",
        explicitExpect: "passed",
        collection: "passed"
      },
      primaryFailure: {
        code: "CHECKPOINT_FAILED",
        message: "Loading is still visible",
        phase: "replay"
      },
      checkpoints: [{
        ...checkpoint,
        status: "failed",
        conditions: [{
          kind: "absentElement",
          status: "failed",
          locator: { resourceId: "loading" }
        }]
      }]
    });
    test.files.set(currentPath, JSON.stringify(failedCheckpoint));
    expect(await test.service.compare({
      baselinePath, reportPath: currentPath
    })).toMatchObject({
      equivalent: false,
      regressions: [{
        kind: "element",
        checkpointId: "search-ready",
        expected: "passed absentElement",
        actual: "failed"
      }]
    });
    test.files.set(currentPath, JSON.stringify(sourceReport({ checkpoints: [] })));
    await expect(test.service.compare({
      baselinePath, reportPath: currentPath
    })).rejects.toMatchObject({ code: "BASELINE_INCOMPARABLE" });
    test.files.set(currentPath, JSON.stringify(sourceReport({
      checkpoints: [{
        ...checkpoint,
        status: "unresolved",
        conditions: [{
          kind: "absentElement",
          status: "unresolved",
          locator: { resourceId: "loading" }
        }]
      }]
    })));
    await expect(test.service.compare({
      baselinePath, reportPath: currentPath
    })).rejects.toMatchObject({ code: "BASELINE_INCOMPARABLE" });
  });

  it("allows a Contract-bound Checkpoint failure to produce a regression diff", async () => {
    const passed = {
      id: "loading-gone",
      status: "passed" as const,
      conditions: [{
        kind: "absentElement" as const,
        status: "passed" as const,
        locator: { resourceId: "loading" }
      }]
    };
    const current = sourceReport({
      status: "failed",
      layers: {
        run: "failed",
        structural: "passed",
        activityCheckpoint: "passed",
        explicitExpect: "passed",
        collection: "passed"
      },
      primaryFailure: { code: "CHECKPOINT_FAILED", message: "loading visible", phase: "replay" },
      checkpoints: [{
        ...passed,
        status: "failed",
        conditions: [{
          kind: "absentElement",
          status: "failed",
          locator: { resourceId: "loading" }
        }]
      }]
    });
    const test = harness({
      source: sourceReport({ checkpoints: [passed] }),
      current
    });
    test.files.set("/reports/source/verdict.json", passingVerdict(reportPath));
    test.files.set("/reports/current/verdict.json", passingVerdict(currentPath, {
      verdict: "fail",
      reason: "CHECKPOINT_FAILED",
      reportStatus: "failed"
    }));
    const baseline = await test.service.captureFromReport(reportPath, {
      contractSha256
    });
    await test.service.write({ path: baselinePath, baseline });
    expect((await test.service.compare({
      baselinePath, reportPath: currentPath
    })).regressions[0]).toMatchObject({
      checkpointId: "loading-gone",
      actual: "failed"
    });
  });

  async function captured(
    input: {
      contract?: boolean;
      includeScreenFacts?: boolean;
    } = {}
  ): Promise<ReturnType<typeof harness>> {
    const test = harness();
    if (input.contract === true) {
      test.files.set("/reports/source/verdict.json", passingVerdict(reportPath));
      test.files.set("/reports/current/verdict.json", passingVerdict(currentPath));
    }
    const baseline = await test.service.captureFromReport(reportPath, {
      ...(input.contract === true ? { contractSha256 } : {}),
      ...(input.includeScreenFacts === undefined
        ? {}
        : { includeScreenFacts: input.includeScreenFacts })
    });
    await test.service.write({ path: baselinePath, baseline });
    return test;
  }

  it("compares a matching report with nonzero coverage", async () => {
    const { service } = await captured();
    const result = await service.compare({
      baselinePath,
      reportPath: currentPath
    });
    expect(result).toMatchObject({
      equivalent: true,
      coverage: { activities: 1, elements: 1, screens: 1 }
    });
  });

  it.each([
    ["Journey", { journey: { name: "Search", sha256: "c".repeat(64) } }],
    ["package", {
      project: {
        root: "/project",
        packageName: "com.other.app",
        launchActivity: "com.example.app.MainActivity"
      }
    }],
    ["status", { status: "failed" }]
  ])("rejects a different %s before comparing facts", async (_, change) => {
    const test = await captured();
    test.files.set(currentPath, JSON.stringify(sourceReport(change as Partial<TapHoundReport>)));
    await expect(test.service.compare({
      baselinePath,
      reportPath: currentPath
    })).rejects.toMatchObject({ code: "BASELINE_INCOMPARABLE" });
  });

  it("rejects malformed reports and historical empty Baselines", async () => {
    const test = await captured();
    test.files.set(currentPath, JSON.stringify({ schemaVersion: 3 }));
    await expect(test.service.compare({
      baselinePath,
      reportPath: currentPath
    })).rejects.toMatchObject({ code: "BASELINE_INCOMPARABLE" });
    test.files.set(currentPath, JSON.stringify(sourceReport()));
    const baseline = JSON.parse(test.files.get(baselinePath) as string) as Record<string, unknown>;
    test.files.set(baselinePath, JSON.stringify({
      ...baseline,
      activities: [],
      elements: [],
      screens: []
    }));
    await expect(test.service.compare({
      baselinePath,
      reportPath: currentPath
    })).rejects.toMatchObject({ code: "BASELINE_EMPTY" });
  });

  it("rejects a report marked passed while a step is not passed", async () => {
    const test = await captured();
    const current = sourceReport();
    const step = current.steps[0];
    if (step === undefined) {
      throw new Error("The source report needs a step");
    }
    current.steps[0] = { ...step, status: "notRun" };
    test.files.set(currentPath, JSON.stringify(current));
    await expect(test.service.compare({
      baselinePath,
      reportPath: currentPath
    })).rejects.toMatchObject({ code: "BASELINE_INCOMPARABLE" });
  });

  it("rejects missing Screen instrumentation rather than calling it a regression", async () => {
    const test = await captured();
    test.files.set(currentPath, JSON.stringify(sourceReport({ screens: [] })));
    await expect(test.service.compare({
      baselinePath,
      reportPath: currentPath
    })).rejects.toMatchObject({ code: "BASELINE_INCOMPARABLE" });
  });

  it("compares plain reports when Screen facts were explicitly excluded", async () => {
    const test = await captured({ includeScreenFacts: false });
    test.files.set(currentPath, JSON.stringify(sourceReport({ screens: [] })));
    const result = await test.service.compare({
      baselinePath,
      reportPath: currentPath
    });
    expect(result).toMatchObject({
      equivalent: true,
      coverage: { activities: 1, elements: 1, screens: 0 }
    });
  });

  it("requires a passing Verdict for the current report and bound Contract", async () => {
    const test = await captured({ contract: true });
    test.files.set("/reports/current/verdict.json", passingVerdict(reportPath));
    await expect(test.service.compare({
      baselinePath,
      reportPath: currentPath
    })).rejects.toMatchObject({ code: "BASELINE_INCOMPARABLE" });
    test.files.set("/reports/current/verdict.json", passingVerdict(
      currentPath, { contractSha256: "c".repeat(64) }
    ));
    await expect(test.service.compare({
      baselinePath,
      reportPath: currentPath
    })).rejects.toMatchObject({ code: "BASELINE_INCOMPARABLE" });
    test.files.set("/reports/current/verdict.json", passingVerdict(currentPath));
    expect((await test.service.compare({
      baselinePath,
      reportPath: currentPath
    })).equivalent).toBe(true);
  });

  it("rejects legacy locator facts without a step identity", async () => {
    const test = await captured();
    const baseline = JSON.parse(test.files.get(baselinePath) as string) as {
      elements: Array<Record<string, unknown>>;
    };
    delete baseline.elements[0]?.stepIndex;
    test.files.set(baselinePath, JSON.stringify(baseline));
    await expect(test.service.compare({
      baselinePath,
      reportPath: currentPath
    })).rejects.toMatchObject({ code: "BASELINE_INCOMPARABLE" });
  });
});
