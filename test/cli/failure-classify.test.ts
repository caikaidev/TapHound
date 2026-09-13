import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import type { CliDependencies, TextOutput } from "../../src/cli/dependencies.js";
import type { FailureClassification } from "../../src/domain/failure-classification.js";
import { fakeWorkspaceLayout } from "../fakes/workspace-layout.js";
import { defaultLocalTargets } from "../fakes/local-targets.js";
import { runtimeConfig, runtimeJourney } from "../fakes/runtime-fixture.js";

class BufferOutput implements TextOutput {
  public value = "";
  public readonly write = (content: string): void => {
    this.value += content;
  };
}

const classification: FailureClassification = {
  version: 1,
  runId: "run-1",
  classificationId: "run-1:LOCATOR_NOT_FOUND:2",
  type: "target_not_found",
  stage: "interaction",
  code: "LOCATOR_NOT_FOUND",
  message: "search target missing",
  stepIndex: 2,
  expected: "search",
  actual: "not found in layout",
  locator: { resourceId: "search" },
  evidenceRefs: ["screenshot-default.png"],
  sourceReportPath: "/runs/run-1/report.json"
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
    failureClassifier: { classify: vi.fn(() => Promise.resolve(classification)) },
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

describe("failure classify", () => {
  it("emits the structured classification with exit 0", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "failure", "classify",
      "--project", "/project",
      "--report", "runs/run-1/report.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([0]);
    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as FailureClassification;
    expect(output.type).toBe("target_not_found");
    expect(output.stage).toBe("interaction");
    expect(output.stepIndex).toBe(2);
    const classify = dependencies.failureClassifier?.classify as ReturnType<typeof vi.fn>;
    expect(classify).toHaveBeenCalledWith("/project/runs/run-1/report.json");
  });

  it("emits text summary without --json", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "failure", "classify",
      "--project", "/project",
      "--report", "runs/run-1/report.json"
    ]);
    expect(exitCodes).toEqual([0]);
    const output = (dependencies.stdout as BufferOutput).value;
    expect(output).toContain("target_not_found");
    expect(output).toContain("interaction");
    expect(output).toContain("LOCATOR_NOT_FOUND");
    expect(output).toContain("expected: search");
    expect(output).toContain("actual: not found in layout");
    expect(output).toContain("evidence: screenshot-default.png");
  });

  it("fails when classifier is unavailable", async () => {
    const exitCodes: number[] = [];
    const dependencies = baseDependencies(exitCodes);
    dependencies.failureClassifier = undefined;
    await createProgram(dependencies).parseAsync([
      "node", "taphound", "failure", "classify",
      "--project", "/project",
      "--report", "runs/run-1/report.json",
      "--json"
    ]);
    expect(exitCodes).toEqual([2]);
    const output = JSON.parse(
      (dependencies.stdout as BufferOutput).value
    ) as { failure: { code: string } };
    expect(output.failure.code).toBe("CONFIG_INVALID");
  });
});