import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import type { Baseline } from "../../src/domain/checkpoint.js";
import type { RegressionCompareResult } from "../../src/domain/checkpoint.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";
import { defaultLocalTargets } from "../fakes/local-targets.js";
import { runtimeConfig, runtimeJourney } from "../fakes/runtime-fixture.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

const baseline: Baseline = {
  version: 1,
  id: "search-baseline",
  journeySha256: "a".repeat(64),
  contractSha256: "b".repeat(64),
  capturedAt: "2026-07-19T10:00:00.000Z",
  packageName: "com.example.app",
  runId: "run-1",
  activities: [{
    stepIndex: 0,
    before: "com.example.app.MainActivity",
    after: "com.example.app.SearchActivity"
  }],
  elements: [{ locator: { resourceId: "search" }, kind: "present" }],
  screens: [{ screen: "search", status: "matched" }],
  sourceReportPath: "/runs/run-1/report.json"
};

const equivalentResult: RegressionCompareResult = {
  version: 1,
  baselineId: "search-baseline",
  journeySha256: "a".repeat(64),
  comparedAt: "2026-07-19T10:00:10.000Z",
  equivalent: true,
  regressions: []
};

function baseDependencies(exitCodes: number[]): CliDependencies {
  return {
    doctor: {
      run: vi.fn(() => Promise.resolve({
        status: "passed" as const,
        runtimeBackend: "adb" as const,
        deviceSerial: "emulator-5554",
        checks: []
      }))
    },
    recorder: { record: vi.fn() },
    verifier: { verify: vi.fn() },
    baselineService: {
      captureFromReport: vi.fn(() => Promise.resolve(baseline)),
      write: vi.fn(() => Promise.resolve()),
      compare: vi.fn(() => Promise.resolve(equivalentResult))
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
    observer: (): { observe: () => Promise<never> } => ({ observe: vi.fn() }),
    generationStarter: { start: vi.fn() },
    runtimeObserver: { observe: vi.fn() },
    workspaceLayout: fakeWorkspaceLayout(),
    localTargets: defaultLocalTargets(),
    readJson: vi.fn((path: string) => Promise.resolve(
      path.includes("journey") ? runtimeJourney : runtimeConfig
    )),
    cwd: () => "/project",
    stdout: new BufferOutput(),
    stderr: new BufferOutput(),
    setExitCode: (code): void => {
      exitCodes.push(code);
    }
  };
}

describe("baseline capture", () => {
  it("captures a baseline from a report and writes it", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "baseline", "capture",
      "--project", "/project",
      "--report", "runs/run-1/report.json",
      "--out", ".taphound/baselines/search.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([0]);
    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as Baseline;
    expect(output.id).toBe("search-baseline");
    const capture = dependencies.baselineService?.captureFromReport as ReturnType<typeof vi.fn>;
    expect(capture).toHaveBeenCalledWith(
      "/project/runs/run-1/report.json",
      {
        id: undefined,
        journeySha256: undefined,
        contractSha256: undefined
      }
    );
  });

  it("fails when baseline service is unavailable", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    dependencies.baselineService = undefined;
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "baseline", "capture",
      "--project", "/project",
      "--report", "runs/run-1/report.json",
      "--out", ".taphound/baselines/search.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([2]);
    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { failure: { code: string } };
    expect(output.failure.code).toBe("CONFIG_INVALID");
  });
});

describe("baseline compare", () => {
  it("reports equivalent with exit 0", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "baseline", "compare",
      "--project", "/project",
      "--baseline", ".taphound/baselines/search.json",
      "--report", "runs/run-2/report.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([0]);
    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as RegressionCompareResult;
    expect(output.equivalent).toBe(true);
  });

  it("reports regressions with exit 1", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    dependencies.baselineService = {
      captureFromReport: vi.fn(),
      write: vi.fn(),
      compare: vi.fn(() => Promise.resolve({
        ...equivalentResult,
        equivalent: false,
        regressions: [{
          kind: "activity" as const,
          stepIndex: 0,
          expected: "before com.example.app.MainActivity",
          actual: "before com.example.app.LauncherActivity"
        }]
      }))
    };
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "baseline", "compare",
      "--project", "/project",
      "--baseline", ".taphound/baselines/search.json",
      "--report", "runs/run-2/report.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([1]);
    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as RegressionCompareResult;
    expect(output.equivalent).toBe(false);
    expect(output.regressions[0]?.kind).toBe("activity");
  });

  it("prints diffs in text mode", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    dependencies.baselineService = {
      captureFromReport: vi.fn(),
      write: vi.fn(),
      compare: vi.fn(() => Promise.resolve({
        ...equivalentResult,
        equivalent: false,
        regressions: [{
          kind: "element" as const,
          locator: { resourceId: "search" },
          expected: "present element",
          actual: "missing"
        }]
      }))
    };
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "baseline", "compare",
      "--project", "/project",
      "--baseline", ".taphound/baselines/search.json",
      "--report", "runs/run-2/report.json"
    ]);
    expect(exitCodes).toEqual([1]);
    const output = (dependencies.stdout as BufferOutput).value;
    expect(output).toContain("- element: expected present element, actual missing");
  });
});